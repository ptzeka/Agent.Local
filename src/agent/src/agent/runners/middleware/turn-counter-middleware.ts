import type { TokenUsage } from "@agent-local/common/tokenusage";
import { MetricsRegistryToken } from "../../runtime/tokens.js";
import { OrchestratorEventTypes } from "../runner-events.js";
import type { RunResult } from "../orchestrator.js";
import { RunnerMiddlewareBase, type RunnerContext } from "./runner-middleware.js";

// folds a turn's usage into the MetricsRegistry off the event bus, so token accounting is a turn-scoped
// unit rather than inline foldCounters/foldDelegatedUsage in the orchestrator loop
// own spend rides orchestrator-message; delegated subtree spend rides tool-result — and only the parent
// bus carries the latter (child runtimes build an unparented Eventing), so dispatch cost counts once
export class TurnCounterMiddleware extends RunnerMiddlewareBase {
  override async invoke(ctx: RunnerContext, next: () => Promise<RunResult>): Promise<RunResult> {
    const metrics = ctx.registry.get(MetricsRegistryToken);
    const unsubscribe = ctx.events.subscribe((event) => {
      const usage = event.payload.usage as TokenUsage | undefined;
      if (event.type === OrchestratorEventTypes.MESSAGE) metrics.recordOwnUsage(usage);
      else if (event.type === OrchestratorEventTypes.TOOL_RESULT) metrics.recordDelegatedUsage(usage);
    });
    // unsubscribe in finally so a thrown turn still detaches the listener from the per-turn bus;
    // flush there too so a snapshot of the turn's cumulative spend lands in the store on every exit path
    try {
      return await next();
    } finally {
      unsubscribe();
      metrics.flush();
    }
  }
}
