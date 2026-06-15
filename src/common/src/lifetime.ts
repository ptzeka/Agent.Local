// cancelling cuts this scope and everything below it, never the parent; holders observe but can't initiate
export class CancellationToken {
  private readonly controller = new AbortController();

  // derived signal handed downward: parent chain OR own controller
  public readonly signal: AbortSignal;

  constructor(parent?: AbortSignal) {
    this.signal = parent
      ? AbortSignal.any([parent, this.controller.signal])
      : this.controller.signal;
  }

  // idempotent; never affects the parent
  public cancel(reason?: unknown): void {
    this.controller.abort(reason);
  }

  // true when this scope OR any ancestor has been cancelled
  public get cancelled(): boolean {
    return this.signal.aborted;
  }
}

// never rejects so shutdown paths keep unwinding past a failing subsystem; false on timeout for the caller to escalate
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
