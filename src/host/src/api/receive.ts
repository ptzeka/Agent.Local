import { Router, type Request, type Response } from "express";
import type { Eventing, ILogger, EventEnvelope } from "@agent-local/common";

// the agent service posts finished turns here (its webhook target). Republish the SAME event onto the host
// bus so the existing workflow path (agent.result -> completeJob) runs unchanged — HTTP is just a bridge.
export function createReceiveApi(bus: Eventing, logger: ILogger): Router {
  const router = Router();

  router.post("/receive", (req: Request, res: Response) => {
    const envelope = req.body as EventEnvelope;
    if (!envelope?.eventType) {
      res.status(400).json({ error: "missing eventType" });
      return;
    }
    bus.publish(envelope.eventType, (envelope.payload ?? {}) as Record<string, unknown>);
    logger.debug?.(`[host] /receive republished ${envelope.eventType}`);
    res.status(202).json({ accepted: true });
  });

  return router;
}
