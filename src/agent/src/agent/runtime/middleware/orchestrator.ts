import { Orchestrator, type OrchestratorPolicies } from "../../runners/orchestrator.js";
import {
  CompactionPolicyToken,
  CompletionPolicyToken,
  ContextContributorToken,
  ContextProviderToken,
  McpRegistryToken,
  OrchestratorToken,
} from "../tokens.js";
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
    ctx.registry.set(OrchestratorToken, new Orchestrator(this.params.role, this.resolvePolicies(ctx)));
    await next();
  }

  // an unregistered slot stays undefined so the Orchestrator applies its own default;
  // registering one is the whole extension story — no edit to the loop
  private resolvePolicies(ctx: RuntimeContext): OrchestratorPolicies {
    const contributors = ctx.registry.getAll(ContextContributorToken);
    return {
      contextProvider: ctx.registry.tryGet(ContextProviderToken),
      compaction: ctx.registry.tryGet(CompactionPolicyToken),
      contributors: contributors.length > 0 ? contributors : undefined,
      completion: ctx.registry.tryGet(CompletionPolicyToken),
    };
  }
}
