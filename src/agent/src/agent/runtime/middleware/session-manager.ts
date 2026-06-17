import { SessionManager } from "../../session/session-manager.js";
import type { SubRuntimeFactory } from "../../runners/subsession.js";
import { MetricsRegistryToken, SessionManagerToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface SessionManagerMiddlewareParams {
  // omitted for a sub-runtime, which is capped at 0 children and never spawns
  subRuntimeFactory?: SubRuntimeFactory;
  // pass 0 for a leaf coordinator that refuses every spawn — the one-level-deep guard
  maxActivePerParent?: number;
}

// builds the manager that owns this session's sub-sessions; it provisions each child via subRuntimeFactory
export class SessionManagerMiddleware implements IMiddleware {
  constructor(private readonly params: SessionManagerMiddlewareParams = {}) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    ctx.registry.set(
      SessionManagerToken,
      new SessionManager(
        this.params.subRuntimeFactory,
        this.params.maxActivePerParent,
        // settled children fold their delegated subtree spend into this runtime's MetricsRegistry
        ctx.registry.get(MetricsRegistryToken),
        // children chain under the runtime's scope, so a runtime/root cancel reaches every detached child
        ctx.runtimeSignal
      )
    );
    await next();
  }
}
