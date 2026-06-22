import { Orchestrator } from "../../runners/orchestrator.js";
import { McpRegistryToken, OrchestratorToken } from "../tokens.js";
import type { AgentRuntimeDeps, IMiddleware, RuntimeContext } from "../types.js";

export interface OrchestratorMiddlewareParams {
  role: AgentRuntimeDeps["orchestratorRole"];
}

// builds the one stateless Orchestrator; it takes its runtime DI handle per turn via RunnerContext, not here
export class OrchestratorMiddleware implements IMiddleware {
  constructor(private readonly params: OrchestratorMiddlewareParams) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    // get() throws if the MCP registry step has not run; the orchestrator's tools come from it
    ctx.registry.get(McpRegistryToken);
    ctx.registry.set(OrchestratorToken, new Orchestrator(this.params.role));
    await next();
  }
}
