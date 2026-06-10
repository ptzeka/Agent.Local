import { Orchestrator } from "../../orchestrator.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

/**
 * OrchestratorMiddleware — creates the Orchestrator that drives this session.
 *
 * Creates an orchestrator with a deferred runtime reference (to be set by
 * AgentRuntime.build() after the runtime is fully initialized). This allows
 * the orchestrator to query the runtime without holding direct dependencies.
 *
 * Requires ctx.toolDescriptors (from ToolsMiddleware) and sets ctx.orchestrator
 * before calling next().
 */
export class OrchestratorMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    if (!ctx.toolDescriptors) {
      throw new Error(
        "OrchestratorMiddleware: requires ctx.toolDescriptors. " +
          "Add ToolsMiddleware earlier in the pipeline."
      );
    }

    ctx.orchestrator = new Orchestrator(undefined as any);
    await next();
  }
}
