// defined here so the tracker has no runner dependency
export interface DispatchAsk {
  tool: string;
  args: Record<string, unknown>;
  intent: string;
}

// per-turn accounting bundling the dispatch cap, duplicate-mutation guard, and periodic-validator gate
// one instance per TurnLoop.run, shared with the dispatch tool; the orchestrator only queries dueForPeriodicCheck
export class DispatchTracker {
  private dispatches = 0;
  private dispatchesSinceCheck = 0;
  // signatures of mutations that SUCCEEDED this turn; an identical re-dispatch is a no-progress loop and is refused
  private readonly succeededSignatures = new Set<string>();
  // signatures admitted but not yet settled; without it two concurrent identical asks both pass the duplicate check
  private readonly inFlightSignatures = new Set<string>();

  constructor(
    private readonly maxDispatches: number,
    private readonly checkInterval: number
  ) {}

  public get count(): number {
    return this.dispatches;
  }

  // the single admission gate: cap and duplicate are decided together, under one synchronous check, because a
  // round's tool calls are concurrent — a two-step check would let identical asks interleave between the steps.
  // counts against the cap even on failure, so a hard loop still burns toward the cap as a backstop
  public reserve(
    signature: string
  ): { ok: true } | { ok: false; kind: "capped" | "duplicate"; reason: string } {
    if (this.dispatches >= this.maxDispatches) {
      return {
        ok: false,
        kind: "capped",
        reason: `dispatch cap of ${this.maxDispatches} per turn reached`,
      };
    }
    if (this.succeededSignatures.has(signature) || this.inFlightSignatures.has(signature)) {
      return { ok: false, kind: "duplicate", reason: "identical mutation already run this turn" };
    }
    this.inFlightSignatures.add(signature);
    this.dispatches += 1;
    return { ok: true };
  }

  // releases the admission. A success is remembered (to catch a later identical re-dispatch) and advances the
  // periodic-check counter; a failure frees the signature so a corrected retry of the same ask is allowed
  public settle(signature: string, ok: boolean): void {
    this.inFlightSignatures.delete(signature);
    if (!ok) return;
    this.succeededSignatures.add(signature);
    this.dispatchesSinceCheck += 1;
  }

  // consumes the counter on a true result so the gate fires at most once per interval
  public dueForPeriodicCheck(): boolean {
    if (this.checkInterval <= 0) return false;
    if (this.dispatchesSinceCheck < this.checkInterval) return false;
    this.dispatchesSinceCheck = 0;
    return true;
  }
}

// args keys sorted recursively so weak models re-emitting via prompted-JSON (where key order drifts) still hash equal
export function dispatchSignature(ask: DispatchAsk): string {
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
