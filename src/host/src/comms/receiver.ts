import { Router, type Request, type Response } from "express";
import type { Eventing, ILogger } from "@agent-local/common";
import type { EventEnvelope } from "./contract.js";
import { requirePermission } from "../user/userContext.js";

// agent -> host RECEIVER: the agent service posts finished turns here (its webhook target). Republish the SAME
// event onto the host bus so the existing workflow path (agent.result -> completeJob) runs unchanged.
export function createReceiveApi(bus: Eventing, logger: ILogger): Router {
  const router = Router();

  // gated: the agent must present a bearer carrying host:callback, so an unauthenticated caller can't inject events
  router.post("/receive", requirePermission("host:callback"), (req: Request, res: Response) => {
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
