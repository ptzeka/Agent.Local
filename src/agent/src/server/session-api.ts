import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { type SessionRegistry } from "./session-registry.js";
import { createSession } from "../agent/session/session.js";
import { type SessionStore } from "../agent/session/session-store.js";

// session lifecycle API (kept separate from comms/: this mints a capability, it is not event transport).
// minting/closing a work session needs no runtime, so it mounts BEFORE the runtime middleware (which would
// otherwise build a runtime — and spurious session/sandbox state — per request). /session/create is
// privileged: gated on agent:trigger from the verified token (same host->agent scope the receiver checks).
// The host owns workId (the unit) and workspaceId (the shared folder guid) and passes both; the agent mints the sessionId.
export function createSessionApi(sessions: SessionRegistry, store: SessionStore): Router {
  const router = Router();

  // the minted session is persisted here (not in the runtime) so the first /receive can resume it by id;
  // the in-memory registry stays the capability check, the store row the resumable state
  router.post("/session/create", async (req: Request, res: Response) => {
    if (!req.userContext?.permissions?.includes("agent:trigger")) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const { workspaceId, workId, userId } = (req.body ?? {}) as {
      workspaceId?: string;
      workId?: string;
      // present for a user-facing (cli) session; absent for a job session owned by the workflow
      userId?: string;
    };
    if (!workspaceId || !workId) {
      res.status(400).json({ error: "workspaceId and workId are required" });
      return;
    }
    const record = sessions.create(workspaceId, workId, userId);
    try {
      const session = createSession({ sessionId: record.sessionId, workspaceId, conversationId: randomUUID() });
      await store.save(session);
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
    const session = await store.load(sessionId);
    if (session) {
      session.status = "done";
      await store.save(session);
    }
    res.status(202).json({ closed: sessions.close(sessionId) });
  });

  return router;
}
