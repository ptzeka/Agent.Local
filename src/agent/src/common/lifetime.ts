/**
 * One cutoff in the cancellation chain: cancelling cuts this scope and everything
 * below it, never the parent — signal holders can observe but not initiate.
 */
export class CancellationToken {
  private readonly controller = new AbortController();

  /** The derived signal to hand downward: parent chain OR own controller. */
  public readonly signal: AbortSignal;

  constructor(parent?: AbortSignal) {
    this.signal = parent
      ? AbortSignal.any([parent, this.controller.signal])
      : this.controller.signal;
  }

  /** Cut everything from this scope down. Idempotent; never affects the parent. */
  public cancel(reason?: unknown): void {
    this.controller.abort(reason);
  }

  /** True when this scope OR any ancestor has been cancelled. */
  public get cancelled(): boolean {
    return this.signal.aborted;
  }
}

/**
 * Bounded wait: true if `work` settled in time, false on timeout (caller escalates).
 * Never rejects — shutdown paths must keep unwinding past a failing subsystem.
 */
export async function settledWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([work.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
