import type { Container } from "@agent-local/common/container";
import type { Eventing } from "@agent-local/common/eventing";
import type { ILogger } from "@agent-local/common/ilogger";
import type { Session } from "../../session/session.js";
import type { AgentRuntimeQueryable } from "../../runtime/types.js";
import type { SubSessionCoordinator } from "../subsession.js";
import type { RunResult } from "../orchestrator.js";

// shared mutable state for one turn, threaded through every onion link so units read/write
// the same turn instead of closure-captured locals; registry resolves runtime services on demand
// the single per-turn bundle: any runner driven in the loop receives this (see UNIFIED_RUNTIME_PLAN §2.0)
export interface RunnerContext {
  readonly session: Session;
  readonly events: Eventing;
  readonly signal: AbortSignal;
  readonly logger: ILogger;
  readonly registry: Container;
  // DI handle: runners resolve runtime singletons through this rather than a wired-in reference
  readonly runtime: AgentRuntimeQueryable;
  // present → expose the synthetic sub-session tools; detached runs get none, so sub-sessions are one level deep
  readonly coordinator?: SubSessionCoordinator;
  // pull seam: returned strings are appended as user turns, so an outside producer steers without racing the loop
  readonly pullInjectedPrompts?: () => string[];
}

// one onion link wrapping a turn: call next() to descend to the core run, or return early to short-circuit
// execution-scoped twin of the build-scoped IMiddleware, so the (ctx, next) pattern is uniform across the codebase
export interface IRunnerMiddleware {
  invoke(ctx: RunnerContext, next: () => Promise<RunResult>): Promise<RunResult>;
}

// extend this, don't instantiate: the default invoke is a transparent pass-through, so a unit
// that only hooks one side (pre or post) overrides without re-stating the forward
export abstract class RunnerMiddlewareBase implements IRunnerMiddleware {
  invoke(_ctx: RunnerContext, next: () => Promise<RunResult>): Promise<RunResult> {
    return next();
  }
}

// first onion link: a transparent pass-through proving the seam runs around a turn
// real behavior lands in later units; the explicit override marks the pre/post wrap points
export class RunnerMiddleware extends RunnerMiddlewareBase {
  override async invoke(
    _ctx: RunnerContext,
    next: () => Promise<RunResult>
  ): Promise<RunResult> {
    return next();
  }
}

// folds the group into an onion around the core run; registration order is outer-to-inner,
// so middlewares[0] runs first and wraps everything below it (mirrors AgentRuntime.runPipeline)
// empty group collapses to the bare core, so the seam is behaviour-neutral until a unit registers
export function composeRunnerPipeline(
  middlewares: readonly IRunnerMiddleware[],
  ctx: RunnerContext,
  core: () => Promise<RunResult>
): () => Promise<RunResult> {
  return middlewares.reduceRight<() => Promise<RunResult>>(
    (next, middleware) => () => middleware.invoke(ctx, next),
    core
  );
}
