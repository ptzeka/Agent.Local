import type { TokenUsage } from "@agent-local/common/tokenusage";
import { MetricsRegistryToken } from "../../runtime/tokens.js";
import { OrchestratorEventTypes } from "../runner-events.js";
import { ceilingBreach, totalSpend, type TokenCeilings } from "../policies/budget.js";
import type { RunResult } from "../turn-loop.js";
import { RunnerMiddlewareBase, type RunnerContext } from "./runner-middleware.js";

// folds a turn's usage into the MetricsRegistry off the event bus, so token accounting is a turn-scoped
// unit rather than inline foldCounters/foldDelegatedUsage in the orchestrator loop
// own spend rides orchestrator-message; delegated subtree spend rides tool-result — and only the parent
// bus carries the latter (child runtimes build an unparented Eventing), so dispatch cost counts once
// the same subscription enforces the token ceilings: it is already the ONE place that sees every fold
export class TurnCounterMiddleware extends RunnerMiddlewareBase {
  override async invoke(ctx: RunnerContext, next: () => Promise<RunResult>): Promise<RunResult> {
    const metrics = ctx.registry.get(MetricsRegistryToken);
    const ceilings = await this.resolveCeilings(ctx);
    // the registry tally is cumulative and store-seeded, so a per-TURN figure needs where this turn started
    const turnBaseline = totalSpend(metrics.totals());

    const unsubscribe = ctx.events.subscribe((event) => {
      const usage = event.payload.usage as TokenUsage | undefined;
      if (event.type === OrchestratorEventTypes.MESSAGE) metrics.recordOwnUsage(usage);
      else if (event.type === OrchestratorEventTypes.TOOL_RESULT) metrics.recordDelegatedUsage(usage);
      else return;
      this.enforce(ctx, totalSpend(metrics.totals()), turnBaseline, ceilings);
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

  // cancelling the turn's cutoff stops the live model call, its tools, and any child runtime at once;
  // the loop reads the cancel REASON to report budget-capped rather than a user stop
  private enforce(
    ctx: RunnerContext,
    sessionSpend: number,
    turnBaseline: number,
    ceilings: TokenCeilings
  ): void {
    if (!ctx.cutoff || ctx.cutoff.cancelled) return;
    const breach = ceilingBreach(sessionSpend, turnBaseline, ceilings);
    if (!breach) return;

    ctx.logger.debug("token ceiling breached", {
      sessionId: ctx.session.sessionId,
      detail: breach.detail,
    });
    ctx.events.publish(OrchestratorEventTypes.BUDGET_EXCEEDED, {
      detail: breach.detail,
      sessionSpend,
      turnSpend: sessionSpend - turnBaseline,
    });
    ctx.cutoff.cancel(breach);
  }

  private async resolveCeilings(ctx: RunnerContext): Promise<TokenCeilings> {
    const config = await ctx.runtime.getConfigurationRegistry().getModelsConfiguration();
    return {
      perTurn: config.orchestration.maxTokensPerTurn ?? 0,
      perSession: config.orchestration.maxTokensPerSession ?? 0,
    };
  }
}
