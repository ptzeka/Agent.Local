import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { type Eventing } from "@agent-local/common";
import { type SessionRegistry } from "./session-registry.js";
import { createSession } from "../agent/session/session.js";
import { type SessionStore } from "../agent/session/session-store.js";
import { EXECUTION_CANCEL, EXECUTION_INTERRUPT } from "./comms/contract.js";

// session lifecycle API (kept separate from comms/: this mints a capability, it is not event transport).
// minting/closing a work session needs no runtime, so it mounts BEFORE the runtime middleware (which would
// otherwise build a runtime — and spurious session/sandbox state — per request). /session/create is
// privileged: gated on agent:trigger from the verified token (same host->agent scope the receiver checks).
// The host owns workId (the unit) and workspaceId (the shared folder guid) and passes both; the agent mints the sessionId.
export function createSessionApi(sessions: SessionRegistry, store: SessionStore, bus: Eventing): Router {
  const router = Router();

  // the minted session is persisted here (not in the runtime) so the first /receive can resume it by id;
  // the in-memory registry stays the capability check, the store row the resumable state
  router.post("/session/create", async (req: Request, res: Response) => {
    if (!req.userContext?.permissions?.includes("agent:trigger")) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const { workspaceId, workId, userId, sessionId } = (req.body ?? {}) as {
      workspaceId?: string;
      workId?: string;
      // present for a user-facing (cli) session; absent for a job session owned by the workflow
      userId?: string;
      // the caller's cached session, if any: honoured when still valid (resumable), else a fresh one is minted
      sessionId?: string;
    };
    if (!workspaceId || !workId) {
      res.status(400).json({ error: "workspaceId and workId are required" });
      return;
    }
    // a passed session is honoured only if its persisted state still exists; otherwise it's stale (e.g. the store
    // was reset) and we mint fresh. empty in -> always mint. so create always answers a valid, resumable session.
    const requestedValid = sessionId ? Boolean(await store.load(sessionId)) : false;
    const record = sessions.create(workspaceId, workId, userId, requestedValid ? sessionId : undefined);
    try {
      // persist a conversation only when the resolved id has none yet — a reuse/rehydrate must not reset the transcript
      if (!(await store.load(record.sessionId))) {
        const session = createSession({ sessionId: record.sessionId, workspaceId, conversationId: randomUUID() });
        await store.save(session);
      }
    } catch (err) {
      sessions.close(record.sessionId);
      res.status(500).json({ error: `session persist failed: ${String(err)}` });
      return;
    }
    res.status(201).json({ sessionId: record.sessionId });
  });

  // close marks the persisted session terminal so its resumable state reflects the host having ended the unit
  router.post("/session/close", async (req: Request, res: Response) => {
    const { sessionId } = (req.body ?? {}) as { sessionId?: string };
    if (!sessionId) {
      res.status(202).json({ closed: false });
      return;
    }
    // abort any in-flight run for this session BEFORE marking it terminal, so a Stop/pause kills the live turn now
    bus.publish(EXECUTION_CANCEL, { sessionId });
    const session = await store.load(sessionId);
    if (session) {
      session.status = "done";
      await store.save(session);
    }
    res.status(202).json({ closed: sessions.close(sessionId) });
  });

  // interrupt cancels the live session's in-flight turn (chat Stop) WITHOUT closing the session — the runtime stays
  // up so the user can send again. The runner does the work (it owns the live-connection registry); we only signal.
  router.post("/session/interrupt", (req: Request, res: Response) => {
    const { sessionId } = (req.body ?? {}) as { sessionId?: string };
    if (!sessionId) {
      res.status(202).json({ interrupted: false });
      return;
    }
    bus.publish(EXECUTION_INTERRUPT, { sessionId });
    res.status(202).json({ interrupted: true });
  });

  return router;
}
