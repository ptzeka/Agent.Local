import { Router, type Request, type Response } from "express";
import { type SessionRegistry } from "./session-registry.js";

// session lifecycle API (kept separate from comms/: this mints a capability, it is not event transport).
// minting/closing a work session needs no runtime, so it mounts BEFORE the runtime middleware (which would
// otherwise build a runtime — and spurious session/sandbox state — per request). /session/create is
// privileged: gated on agent:trigger from the verified token (same host->agent scope the receiver checks).
// The host owns workId (the unit) and workspaceId (the shared folder guid) and passes both; the agent mints the sessionId.
export function createSessionApi(sessions: SessionRegistry): Router {
  const router = Router();

  router.post("/session/create", (req: Request, res: Response) => {
    if (!req.userContext?.permissions?.includes("agent:trigger")) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const { workspaceId, workId } = (req.body ?? {}) as { workspaceId?: string; workId?: string };
    if (!workspaceId || !workId) {
      res.status(400).json({ error: "workspaceId and workId are required" });
      return;
    }
    const record = sessions.create(workspaceId, workId);
    res.status(201).json({ sessionId: record.sessionId });
  });

  router.post("/session/close", (req: Request, res: Response) => {
    const { sessionId } = (req.body ?? {}) as { sessionId?: string };
    res.status(202).json({ closed: sessionId ? sessions.close(sessionId) : false });
  });

  return router;
}
