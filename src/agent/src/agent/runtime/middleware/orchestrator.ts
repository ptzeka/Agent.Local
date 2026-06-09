import { Orchestrator } from "../../orchestrator.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

/**
 * OrchestratorMiddleware — builds the single stateless Orchestrator that drives
 * this session's turns, wiring in the model registry and tool client from the
 * runtime's infrastructure deps.
 *
 * Reads ctx.registry + ctx.tools (always seeded by AgentRuntime) and sets
 * ctx.orchestrator before calling next().
 */
export class OrchestratorMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    ctx.orchestrator = new Orchestrator(ctx.registry, ctx.tools);
    await next();
  }
}
