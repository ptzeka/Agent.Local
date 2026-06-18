import { Router, type Request, type Response } from "express";
import type { ILogger, EventEnvelope } from "@agent-local/common";
import { WORKFLOW_JOB, type WorkflowJob } from "./contract.js";
import type { SessionManager } from "./session-manager.js";

// receive API: the host's sender posts here. /session/create returns a sessionId the host correlates to a
// camunda job; /events is the envelope bridge — the same bus events, carried over HTTP and run by the agent.
export function createApi(sessions: SessionManager, logger: ILogger): Router {
  const router = Router();

  router.post("/session/create", (_req: Request, res: Response) => {
    sessions
      .create()
      .then((sessionId) => res.status(201).json({ sessionId }))
      .catch((err) => res.status(500).json({ error: String(err) }));
  });

  // envelope receiver { eventType, payload }. The answer returns out-of-band via the sender's webhook, so
  // this responds 202 immediately (fire-and-forget) rather than blocking on the runtime turn.
  router.post("/events", (req: Request, res: Response) => {
    const envelope = req.body as EventEnvelope;
    if (envelope?.eventType !== WORKFLOW_JOB) {
      res.status(400).json({ error: `unsupported eventType ${String(envelope?.eventType)}` });
      return;
    }
    const job = envelope.payload as WorkflowJob & { sessionId: string };
    void sessions.run(job).catch((err) => logger.error?.("[agent-server] run failed", err));
    res.status(202).json({ accepted: true });
  });

  router.post("/session/:id/close", (req: Request, res: Response) => {
    void sessions.close(req.params.id);
    res.status(202).json({ closing: req.params.id });
  });

  return router;
}
