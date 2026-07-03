import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { type Eventing } from "@agent-local/common";
import { type SessionRegistry } from "../session-registry.js";
import { createSession } from "../../agent/session/session.js";
import { type SessionStore } from "../../agent/session/session-store.js";
import { EXECUTION_CANCEL, EXECUTION_INTERRUPT } from "../comms/contract.js";

// session lifecycle API (kept separate from comms/: this owns the session unit, it is not event transport).
// minting/closing a work session needs no runtime, so it mounts BEFORE the runtime middleware (which would
// otherwise build a runtime — and spurious session/sandbox state — per request). Every session is OWNED by the
// create caller's token subject (a human via OBO, or the workflow-user via the host's dispatch token); create
// stamps that owner and close/interrupt refuse any caller who is not it. The host owns workId (the unit) and
// workspaceId (the shared folder guid) and passes both; the agent mints the sessionId.
export function createSessionApi(sessions: SessionRegistry, store: SessionStore, bus: Eventing): Router {
  const router = Router();

  // the session owner is the live registry record when present (dropped by a restart), else the durable owner
  // stamped onto the persisted session at create. undefined only for an unknown session id.
  const ownerOf = async (sessionId: string): Promise<string | undefined> => {
    return sessions.get(sessionId)?.userId ?? (await store.getSessionById(sessionId))?.user?.sub;
  };

  // the minted session is persisted here (not in the runtime) so the first /receive can resume it by id;
  // the in-memory registry stays the live owner check, the store row the resumable + durable-owner state
  router.post("/session/create", async (req: Request, res: Response) => {
    // the owner is the verified token subject — never the request body, so a caller can only ever create a session
    // it owns. userContextMiddleware already required a valid token carrying agent:trigger to populate this.
    const ownerUserId = req.userContext?.userInfo?.userId;
    if (!ownerUserId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const { workspaceId, workId, sessionId } = (req.body ?? {}) as {
      workspaceId?: string;
      workId?: string;
      // the caller's cached session, if any: honoured when still valid (resumable), else a fresh one is minted
      sessionId?: string;
    };
    if (!workspaceId || !workId) {
      res.status(400).json({ error: "workspaceId and workId are required" });
      return;
    }
    // honour the caller's id when given: the host mints a fresh id PER STEP and expects the agent to create exactly
    // that session, so two steps of one work never collide on a reused per-work session. A cli re-init passes its
    // cached id to resume. Only an absent id falls back to find-by-work / mint. The transcript is created below when
    // the resolved id has none yet, so a brand-new (not-yet-persisted) id is still valid and resumable.
    const record = sessions.create(workspaceId, workId, ownerUserId, sessionId);
    try {
      // persist a conversation only when the resolved id has none yet — a reuse/rehydrate must not reset the transcript
      if (!(await store.getSessionById(record.sessionId))) {
        // set the external reference (host workId) ONLY here, at first creation — a reuse/rehydrate skips this
        // branch, so the key minted with the session is never rewritten
        const session = createSession({ sessionId: record.sessionId, workspaceId, conversationId: randomUUID(), externalReferenceKey: workId });
        // stamp the owner durably so close/interrupt can gate on it after a restart drops the in-memory registry;
        // the runtime later refines this Principal (same subject) on the first turn
        session.user = { sub: ownerUserId, isAuthenticated: true, claims: {}, scopes: [] };
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
    const callerUserId = req.userContext?.userInfo?.userId;
    if (!callerUserId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const { sessionId } = (req.body ?? {}) as { sessionId?: string };
    if (!sessionId) {
      res.status(202).json({ closed: false });
      return;
    }
    // a caller may only touch a session it owns: refuse when the resolved owner is someone else. An unknown session
    // (no owner) stays a no-op close below rather than a 403, so a stale id is harmless.
    const owner = await ownerOf(sessionId);
    if (owner && owner !== callerUserId) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    // abort any in-flight run for this session BEFORE marking it terminal, so a Stop/pause kills the live turn now
    bus.publish(EXECUTION_CANCEL, { sessionId });
    const session = await store.getSessionById(sessionId);
    if (session) {
      session.status = "done";
      await store.save(session);
    }
    res.status(202).json({ closed: sessions.close(sessionId) });
  });

  // interrupt cancels the live session's in-flight turn (chat Stop) WITHOUT closing the session — the runtime stays
  // up so the user can send again. The runner does the work (it owns the live-connection registry); we only signal.
  router.post("/session/interrupt", async (req: Request, res: Response) => {
    const callerUserId = req.userContext?.userInfo?.userId;
    if (!callerUserId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const { sessionId } = (req.body ?? {}) as { sessionId?: string };
    if (!sessionId) {
      res.status(202).json({ interrupted: false });
      return;
    }
    // same owner gate as close: only the session's owner may interrupt its turn
    const owner = await ownerOf(sessionId);
    if (owner && owner !== callerUserId) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    bus.publish(EXECUTION_INTERRUPT, { sessionId });
    res.status(202).json({ interrupted: true });
  });

  return router;
}
