import { SessionManager } from "../../session-manager.js";
import type { SubRuntimeFactory } from "../../subsession.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface SessionManagerMiddlewareParams {
  /**
   * Factory that composes a fresh child runtime per spawn. Required for a
   * top-level pipeline (so its sub-sessions can be built); omitted for a
   * sub-runtime, which is capped at 0 children and therefore never spawns.
   */
  subRuntimeFactory?: SubRuntimeFactory;
  /**
   * Per-parent active-children ceiling. Defaults to the manager's own default.
   * Pass 0 to make this a leaf coordinator that refuses every spawn — the
   * one-level-deep guard for sub-runtimes.
   */
  maxActivePerParent?: number;
}

/**
 * SessionManagerMiddleware — builds the manager that owns sub-sessions spawned
 * within this session.
 *
 * The manager now provisions each child by building a whole new runtime through
 * the sub-pipeline (injected as `subRuntimeFactory`), so it no longer composes
 * the parent's orchestrator/inbox/store — it just needs the factory. Sets
 * ctx.sessionManager before calling next().
 */
export class SessionManagerMiddleware implements IMiddleware {
  constructor(private readonly params: SessionManagerMiddlewareParams = {}) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    ctx.sessionManager = new SessionManager(
      this.params.subRuntimeFactory,
      this.params.maxActivePerParent
    );
    await next();
  }
}
