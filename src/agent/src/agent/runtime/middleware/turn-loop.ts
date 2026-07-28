import { TurnLoop, type TurnPolicies } from "../../runners/turn-loop.js";
import {
  CompactionPolicyToken,
  CompletionPolicyToken,
  ContextContributorToken,
  ContextProviderToken,
  McpRegistryToken,
  TurnLoopToken,
} from "../tokens.js";
import type { AgentRuntimeDeps, IMiddleware, RuntimeContext } from "../types.js";

export interface TurnLoopMiddlewareParams {
  role: AgentRuntimeDeps["orchestratorRole"];
}

// builds the one stateless TurnLoop; it takes its runtime DI handle per turn via RunnerContext, not here
export class TurnLoopMiddleware implements IMiddleware {
  constructor(private readonly params: TurnLoopMiddlewareParams) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    // get() throws if the MCP registry step has not run; the turn's tools come from it
    ctx.registry.get(McpRegistryToken);
    ctx.registry.set(TurnLoopToken, new TurnLoop(this.params.role, this.resolvePolicies(ctx)));
    await next();
  }

  // an unregistered slot stays undefined so the TurnLoop applies its own default;
  // registering one is the whole extension story — no edit to the loop
  private resolvePolicies(ctx: RuntimeContext): TurnPolicies {
    const contributors = ctx.registry.getAll(ContextContributorToken);
    return {
      contextProvider: ctx.registry.tryGet(ContextProviderToken),
      compaction: ctx.registry.tryGet(CompactionPolicyToken),
      contributors: contributors.length > 0 ? contributors : undefined,
      completion: ctx.registry.tryGet(CompletionPolicyToken),
    };
  }
}
