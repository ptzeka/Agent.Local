import { Router, type Request, type Response } from "express";
import type { Eventing, ILogger } from "@agent-local/common";
import { requirePermission } from "../user/userContext.js";
import { AGENT_RESULT, type ExecutionResult } from "./contract.js";

// agent -> host RECEIVER: the agent service POSTs finished runs here (its webhook target). It translates the
// neutral ExecutionResult back into the host's engine vocabulary — runId is the temporalId the workflow path
// routes on — and republishes agent.result onto the bus so the existing completion path runs unchanged.
export class HttpEventReceiver {
  constructor(
    private readonly bus: Eventing,
    private readonly logger: ILogger,
  ) {}

  // map the neutral result onto the host bus: runId == temporalId == workId, the key the workflow mount reports on
  async receive(result: ExecutionResult): Promise<void> {
    this.bus.publish(AGENT_RESULT, {
      temporalId: result.runId,
      result: result.result,
      outcome: result.outcome,
      // carried so the work service closes THIS step's per-step session once its answer has landed
      sessionId: result.sessionId,
    });
    this.logger.debug?.(`[host] /receive routed run ${result.runId} (${result.outcome})`);
  }

  // gated: the agent must present a bearer carrying host:callback, so an unauthenticated caller can't inject results
  routes(): Router {
    const router = Router();
    router.post("/receive", requirePermission("host:callback"), (req: Request, res: Response) => {
      const result = req.body as ExecutionResult;
      if (!result?.runId) {
        res.status(400).json({ error: "runId is required" });
        return;
      }
      void this.receive(result).catch((err) => this.logger.error?.("[host] receive failed", err));
      res.status(202).json({ accepted: true });
    });
    return router;
  }
}
