// per-turn accounting for agent calls: the per-agent cap and the periodic-validator gate
// one instance per TurnLoop.run, shared with every agent tool; the coordinator only queries dueForPeriodicCheck
export class DispatchTracker {
  private dispatches = 0;
  private dispatchesSinceCheck = 0;
  // counted per agent, not turn-wide: one agent looping must not starve an unrelated one of its budget
  private readonly countsByKey = new Map<string, number>();

  constructor(
    private readonly defaultCap: number,
    private readonly checkInterval: number
  ) {}

  public get count(): number {
    return this.dispatches;
  }

  // one synchronous check, because a round's tool calls are concurrent — anything spread over an await
  // would let two calls interleave past the same remaining budget
  // counts even when the call goes on to fail, so a hard loop still burns toward the cap as a backstop
  public reserve(key: string, cap?: number): { ok: true } | { ok: false; reason: string } {
    const limit = cap ?? this.defaultCap;
    const used = this.countsByKey.get(key) ?? 0;
    if (used >= limit) {
      return { ok: false, reason: `call cap of ${limit} per turn reached for "${key}"` };
    }
    this.countsByKey.set(key, used + 1);
    this.dispatches += 1;
    return { ok: true };
  }

  // only a settled SUCCESS advances the periodic check; a failed call is not progress worth validating
  public settle(ok: boolean): void {
    if (ok) this.dispatchesSinceCheck += 1;
  }

  // consumes the counter on a true result so the gate fires at most once per interval
  public dueForPeriodicCheck(): boolean {
    if (this.checkInterval <= 0) return false;
    if (this.dispatchesSinceCheck < this.checkInterval) return false;
    this.dispatchesSinceCheck = 0;
    return true;
  }
}
