import type { ExecutorAsk } from "../runners/executor.js";

/**
 * DispatchTracker — per-turn accounting for `dispatch_executor`.
 *
 * Pulls together the three pieces of state the orchestrator loop used to keep
 * loose: the dispatch cap, the duplicate-mutation guard, and the
 * every-N-dispatches periodic-validator gate. One instance is created per
 * `Orchestrator.run` turn and shared with the dispatch tool through the
 * synthetic-tool context; the orchestrator only queries `dueForPeriodicCheck`.
 */
export class DispatchTracker {
  private dispatches = 0;
  private dispatchesSinceCheck = 0;
  /**
   * Signatures (tool + stable-stringified args) of dispatches that already
   * SUCCEEDED this turn. A re-dispatch of an identical, already-succeeded
   * mutation is a no-progress loop and is refused by the dispatch tool.
   */
  private readonly succeededSignatures = new Set<string>();

  constructor(
    private readonly maxDispatches: number,
    private readonly checkInterval: number
  ) {}

  /** Dispatch slots reserved this turn (only counts those under the cap). */
  public get count(): number {
    return this.dispatches;
  }

  /**
   * Reserve a dispatch slot. Counts against the cap whether or not the dispatch
   * ultimately succeeds — a hard loop therefore still burns down toward the cap
   * as a backstop. Returns the reason string when the cap is already reached.
   */
  public reserve(): { ok: true } | { ok: false; reason: string } {
    if (this.dispatches >= this.maxDispatches) {
      return { ok: false, reason: `dispatch cap of ${this.maxDispatches} per turn reached` };
    }
    this.dispatches += 1;
    return { ok: true };
  }

  /** Has this exact mutation already landed successfully this turn? */
  public isDuplicate(signature: string): boolean {
    return this.succeededSignatures.has(signature);
  }

  /**
   * Record a genuinely-successful mutation: remember its signature (so a later
   * identical re-dispatch is caught) and advance the periodic-check counter.
   */
  public recordSuccess(signature: string): void {
    this.succeededSignatures.add(signature);
    this.dispatchesSinceCheck += 1;
  }

  /**
   * True when enough successful dispatches have accrued to warrant a mid-flight
   * validator check. Consumes the counter (resets to zero) on a true result so
   * the gate fires at most once per interval.
   */
  public dueForPeriodicCheck(): boolean {
    if (this.checkInterval <= 0) return false;
    if (this.dispatchesSinceCheck < this.checkInterval) return false;
    this.dispatchesSinceCheck = 0;
    return true;
  }
}

/**
 * Stable identity for a dispatch: its tool name plus a canonical stringify of
 * its args (object keys sorted recursively). Order-independence matters because
 * weak models re-emit args via the prompted-JSON fallback, where key order can
 * drift between otherwise-identical calls — a naive JSON.stringify would miss
 * the duplicate.
 */
export function dispatchSignature(ask: ExecutorAsk): string {
  return `${ask.tool}::${stableStringify(ask.args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
