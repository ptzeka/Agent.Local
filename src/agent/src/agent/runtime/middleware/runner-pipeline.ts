import { RunnerMiddleware } from "../../runners/middleware/runner-middleware.js";
import { TurnCounterMiddleware } from "../../runners/middleware/turn-counter-middleware.js";
import { RunnerMiddlewareToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

// registers the runner-middleware onion units into the group; AgentRuntime folds them around each turn
// adding a turn-scoped behaviour means registering a unit here, never editing the core loop
export class RunnerPipelineMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    ctx.registry.set(RunnerMiddleware, new RunnerMiddleware()).by(RunnerMiddlewareToken);
    ctx.registry.set(TurnCounterMiddleware, new TurnCounterMiddleware()).by(RunnerMiddlewareToken);
    await next();
  }
}
