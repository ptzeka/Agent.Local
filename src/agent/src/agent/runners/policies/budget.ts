import type { UsageTotals } from "../../session/session.js";

// ---------------------------------------------------------------------------
// Token ceilings
// ---------------------------------------------------------------------------

// a breach is a CANCEL, not a race: the guard cancels the turn's scope and the whole downward chain
// (live model call, its tools, any child runtime) collapses on the one signal — no promise racing a deadline
export const BUDGET_CANCEL_KIND = "budget-exceeded" as const;

// carried as the AbortSignal's `reason`, so a budget stop is distinguishable from a user stop even
// after AbortSignal.any has merged the parent chain
export interface BudgetCancelReason {
  kind: typeof BUDGET_CANCEL_KIND;
  detail: string;
}

export interface TokenCeilings {
  // 0 = unlimited
  perTurn: number;
  perSession: number;
}

// every token the owner caused, spent directly or delegated — a ceiling that ignored subtree cost
// would be trivially escaped by dispatching the work to a child
export function totalSpend(totals: Readonly<UsageTotals>): number {
  return (
    totals.inputTokens +
    totals.outputTokens +
    totals.cacheReadInputTokens +
    totals.cacheCreationInputTokens +
    totals.inputTokensTallied +
    totals.outputTokensTallied +
    totals.cacheReadInputTokensTallied +
    totals.cacheCreationInputTokensTallied
  );
}

// the session figure is the registry's cumulative tally (seeded from the store, so it spans restarts);
// the turn figure is that minus the baseline taken when the turn opened
export function ceilingBreach(
  sessionSpend: number,
  turnBaseline: number,
  ceilings: TokenCeilings
): BudgetCancelReason | null {
  if (ceilings.perSession > 0 && sessionSpend >= ceilings.perSession) {
    return breach(`session token ceiling reached (${sessionSpend}/${ceilings.perSession})`);
  }
  const turnSpend = sessionSpend - turnBaseline;
  if (ceilings.perTurn > 0 && turnSpend >= ceilings.perTurn) {
    return breach(`turn token ceiling reached (${turnSpend}/${ceilings.perTurn})`);
  }
  return null;
}

// narrows the opaque abort reason; anything else (user stop, shutdown) is not ours to claim
export function isBudgetCancel(signal: AbortSignal | undefined): boolean {
  return budgetCancelDetail(signal) !== null;
}

export function budgetCancelDetail(signal: AbortSignal | undefined): string | null {
  if (!signal?.aborted) return null;
  const reason = signal.reason as Partial<BudgetCancelReason> | undefined;
  if (reason && typeof reason === "object" && reason.kind === BUDGET_CANCEL_KIND) {
    return reason.detail ?? BUDGET_CANCEL_KIND;
  }
  return null;
}

function breach(detail: string): BudgetCancelReason {
  return { kind: BUDGET_CANCEL_KIND, detail };
}
