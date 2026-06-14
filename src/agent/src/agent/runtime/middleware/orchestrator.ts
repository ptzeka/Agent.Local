import { Orchestrator } from "../../runners/orchestrator.js";
import { McpRegistryToken, OrchestratorToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface OrchestratorMiddlewareParams {
  includeSubSessions?: boolean;
  role: "orchestrator" | "executor";
}

// creates the Orchestrator with a deferred runtime reference, which AgentRuntime.build() sets once init completes
export class OrchestratorMiddleware implements IMiddleware {
  constructor(private readonly params: OrchestratorMiddlewareParams) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    // get() throws if the MCP registry step has not run; the orchestrator's tools come from it
    ctx.registry.get(McpRegistryToken);
    const role = this.params.role ?? "orchestrator";
    ctx.registry.set(OrchestratorToken, new Orchestrator(role));
    await next();
  }
}
