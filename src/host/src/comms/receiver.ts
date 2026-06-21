import { Router, type Request, type Response } from "express";
import type { Eventing, ILogger, IReceiver, EventEnvelope } from "@agent-local/common";
import { requirePermission } from "../user/userContext.js";

// agent -> host RECEIVER: the agent service posts finished turns here (its webhook target). receive() republishes
// the SAME event onto the host bus so the existing workflow path (agent.result -> completeJob) runs unchanged;
// routes() is the gated express adapter that calls it. needs no per-request context, so IReceiver's Ctx stays void.
export class HttpEventReceiver implements IReceiver {
  constructor(
    private readonly bus: Eventing,
    private readonly logger: ILogger,
  ) {}

  // republish the peer's event onto the local bus — HTTP is a pure bridge, the swap point is the envelope
  async receive(envelope: EventEnvelope): Promise<void> {
    this.bus.publish(envelope.eventType, (envelope.payload ?? {}) as Record<string, unknown>);
    this.logger.debug?.(`[host] /receive republished ${envelope.eventType}`);
  }

  // gated: the agent must present a bearer carrying host:callback, so an unauthenticated caller can't inject events
  routes(): Router {
    const router = Router();
    router.post("/receive", requirePermission("host:callback"), (req: Request, res: Response) => {
      const envelope = req.body as EventEnvelope;
      if (!envelope?.eventType) {
        res.status(400).json({ error: "missing eventType" });
        return;
      }
      void this.receive(envelope).catch((err) => this.logger.error?.("[host] receive failed", err));
      res.status(202).json({ accepted: true });
    });
    return router;
  }
}
