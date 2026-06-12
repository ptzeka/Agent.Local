import { Orchestrator } from "../../runners/orchestrator.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface OrchestratorMiddlewareParams {
  includeSubSessions?: boolean;
  role: "orchestrator" | "executor";
}

/**
 * OrchestratorMiddleware — assembles tool descriptors and creates the Orchestrator.
 *
 * Combines the work of the removed ToolsMiddleware: assembles all tool descriptors
 * (MCP tools + executor + synthetic tools) and creates an orchestrator with a
 * deferred runtime reference (to be set by AgentRuntime.build() after the runtime
 * is fully initialized).
 *
 * Requires ctx.tools (McpClientRegistry) and sets ctx.toolDescriptors and
 * ctx.orchestrator before calling next().
 */
export class OrchestratorMiddleware implements IMiddleware {
  constructor(private readonly params: OrchestratorMiddlewareParams) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    if (!ctx.mcpRegistry) {
      throw new Error(
        "OrchestratorMiddleware: requires ctx.tools (McpClientRegistry). " +
          "Ensure the registry is set up before this middleware."
      );
    }
    ctx.orchestrator = new Orchestrator(this.params.role);
    await next();
  }
}
