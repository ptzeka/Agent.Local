import type { TokenUsage } from "@agent-local/common/tokenusage";
import { foldCounters, foldDelegatedUsage, newUsageTotals, type UsageTotals } from "../../session/session.js";
import type { MetricsRecord, MetricsStore } from "./metrics-store.js";

export interface MetricsRegistryParams {
  sessionId: string;
  parentSessionId?: string;
  store: MetricsStore;
}

// container-owned token accounting for one runtime: TurnCounterMiddleware folds turn usage in off the
// event bus, so the orchestrator loop no longer mutates session.counters to track spend
// own model spend stays apart from delegated subtree spend, mirroring the SessionCounters split
// the tally is durable: it seeds from the store on construction (so a resumed session continues its running
// total) and flush() snapshots it back, last-write-wins per sessionId
export class MetricsRegistry {
  private readonly tally: UsageTotals;
  // one entry per model call, so iterations/turn is derivable without re-walking the transcript
  private readonly ownRounds: TokenUsage[] = [];

  constructor(private readonly params: MetricsRegistryParams) {
    this.tally = seedFrom(params.store.latestFor(params.sessionId));
  }

  // a single model call's own spend
  recordOwnUsage(usage: TokenUsage | undefined): void {
    if (!usage) return;
    this.ownRounds.push(usage);
    foldCounters(this.tally, usage);
  }

  // one dispatch's delegated subtree spend, already aggregated by the child runtime
  recordDelegatedUsage(usage: TokenUsage | undefined): void {
    foldDelegatedUsage(this.tally, usage);
  }

  rounds(): readonly TokenUsage[] {
    return this.ownRounds;
  }

  totals(): Readonly<UsageTotals> {
    return this.tally;
  }

  // appends the current cumulative snapshot; callers flush at a settle point (turn end, child fold-in)
  flush(): void {
    const record: MetricsRecord = {
      ts: new Date().toISOString(),
      sessionId: this.params.sessionId,
      parentSessionId: this.params.parentSessionId,
      ...this.tally,
    };
    this.params.store.append(record);
  }
}

// strips the record's metadata down to the eight token figures; a missing record (first run) starts at zero
function seedFrom(record: MetricsRecord | null): UsageTotals {
  const totals = newUsageTotals();
  if (!record) return totals;
  totals.inputTokens = record.inputTokens;
  totals.outputTokens = record.outputTokens;
  totals.cacheReadInputTokens = record.cacheReadInputTokens;
  totals.cacheCreationInputTokens = record.cacheCreationInputTokens;
  totals.inputTokensTallied = record.inputTokensTallied;
  totals.outputTokensTallied = record.outputTokensTallied;
  totals.cacheReadInputTokensTallied = record.cacheReadInputTokensTallied;
  totals.cacheCreationInputTokensTallied = record.cacheCreationInputTokensTallied;
  return totals;
}
