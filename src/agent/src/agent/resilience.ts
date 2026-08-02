import { isTransientError, retryTransient } from "./providers/retry.js";

// ---------------------------------------------------------------------------
// Resilience at the ports
// ---------------------------------------------------------------------------

// retry + circuit breaking as a property of the two OUTBOUND PORTS (LLMProvider.chat, the tool client),
// not of each implementation — otherwise every new provider and every new MCP client re-earns it by hand
// stateful on purpose: breaker counts are per runtime, so a server that died stays open across turns
// instead of being re-probed by every new turn

export interface ResilienceNotice {
  // which port raised it, for the log line: "model" | "tool"
  port: string;
  // the breaker key — provider name or server name
  key: string;
  kind: "retry" | "breaker-open" | "breaker-closed";
  attempt?: number;
  message: string;
}

export interface ResilienceOptions {
  // total tries INCLUDING the first
  maxAttempts?: number;
  baseDelayMs?: number;
  // consecutive transient failures that open the breaker; 0 disables breaking entirely
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  // bulkhead: in-flight calls allowed per key before the rest queue; 0 disables the limit entirely
  maxConcurrent?: number;
  // callers allowed to wait for a permit before the ceiling starts refusing instead of queueing; 0 is unbounded
  maxQueued?: number;
  // how long a caller may wait for a permit before it gives up; 0 waits indefinitely
  maxWaitMs?: number;
  onNotice?: (notice: ResilienceNotice) => void;
}

export interface RunOptions {
  signal?: AbortSignal;
  // lets the port veto a retry it cannot safely repeat (a stream that already emitted tokens)
  shouldRetry?: (err: unknown) => boolean;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_BREAKER_THRESHOLD = 4;
const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_CONCURRENT = 0;
const DEFAULT_MAX_QUEUED = 0;
const DEFAULT_MAX_WAIT_MS = 0;

// thrown INSTEAD of calling through while a key's breaker is open, so a dead dependency fails fast
// rather than burning an attempt (and a timeout) on every iteration of a turn
export class BreakerOpenError extends Error {
  constructor(readonly key: string, readonly retryInMs: number) {
    super(
      `"${key}" is unavailable: ${Math.ceil(retryInMs / 1000)}s left on the circuit breaker ` +
        `after repeated failures.`
    );
  }
}

// thrown INSTEAD of waiting when the bulkhead cannot seat a caller: the queue is full, the wait ran out, or
// the caller was cancelled while parked. Typed like BreakerOpenError so a port can tell "refused" from "failed"
export class BulkheadRejectedError extends Error {
  constructor(readonly key: string, readonly reason: "queue-full" | "timeout" | "cancelled", detail: string) {
    super(`"${key}" call refused by the concurrency limit: ${detail}`);
  }
}

// one key's health AND its capacity: the breaker decides whether a call may run, the bulkhead how many may
// run at once. Both are per-dependency facts about the same key, so they share one entry rather than two maps
interface KeyState {
  consecutiveFailures: number;
  openedAt: number | null;
  active: number;
  waiters: Array<{ admit: () => void; abort: () => void }>;
}

export class ResiliencePolicy {
  private readonly keys = new Map<string, KeyState>();

  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly maxWaitMs: number;
  private readonly onNotice?: (notice: ResilienceNotice) => void;

  constructor(private readonly port: string, options: ResilienceOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.breakerThreshold = options.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD;
    this.breakerCooldownMs = options.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.onNotice = options.onNotice;
  }

  // the permit is taken FIRST so the breaker verdict reflects the moment the call actually runs, not the
  // moment it queued — a call parked behind a ceiling must not act on a reading that has since gone stale
  async run<T>(key: string, work: () => Promise<T>, options: RunOptions = {}): Promise<T> {
    await this.acquire(key, options.signal);
    try {
      return await this.runAdmitted(key, work, options);
    } finally {
      this.release(key);
    }
  }

  // ---------------------------------------------------------------------------
  // Retry + breaker
  // ---------------------------------------------------------------------------

  private async runAdmitted<T>(key: string, work: () => Promise<T>, options: RunOptions): Promise<T> {
    const blocked = this.blockedFor(key);
    if (blocked > 0) throw new BreakerOpenError(key, blocked);

    let attempt = 0;
    try {
      const result = await retryTransient(work, {
        signal: options.signal,
        maxAttempts: this.maxAttempts,
        baseDelayMs: this.baseDelayMs,
        shouldRetry: (err) => {
          const retrying = options.shouldRetry ? options.shouldRetry(err) : isTransientError(err);
          // a silent retry loop is indistinguishable from a slow model, so every one is announced
          if (retrying) {
            attempt += 1;
            this.notify({
              port: this.port,
              key,
              kind: "retry",
              attempt,
              message: `retrying "${key}" after ${describe(err)}`,
            });
          }
          return retrying;
        },
      });
      this.recordSuccess(key);
      return result;
    } catch (err) {
      // only a transient failure counts toward the breaker: a 400 schema error is the CALLER's fault
      // and would otherwise open the breaker on a perfectly healthy dependency
      if (isTransientError(err)) this.recordFailure(key);
      throw err;
    }
  }

  // ms remaining on an open breaker; 0 when the key may be called (closed, or the cooldown has elapsed
  // and this call is the half-open probe)
  private blockedFor(key: string): number {
    const state = this.keys.get(key);
    if (!state?.openedAt) return 0;
    const remaining = this.breakerCooldownMs - (Date.now() - state.openedAt);
    return remaining > 0 ? remaining : 0;
  }

  private recordSuccess(key: string): void {
    const state = this.keys.get(key);
    if (!state) return;
    // a successful half-open probe closes the breaker
    if (state.openedAt) {
      this.notify({ port: this.port, key, kind: "breaker-closed", message: `"${key}" recovered` });
    }
    state.consecutiveFailures = 0;
    state.openedAt = null;
  }

  private recordFailure(key: string): void {
    if (this.breakerThreshold <= 0) return;
    const state = this.stateFor(key);
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.breakerThreshold) {
      state.openedAt = Date.now();
      this.notify({
        port: this.port,
        key,
        kind: "breaker-open",
        message: `"${key}" failed ${state.consecutiveFailures}× — pausing calls for ${Math.round(this.breakerCooldownMs / 1000)}s`,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Bulkhead
  // ---------------------------------------------------------------------------

  // a permit for `key`, immediately or parked FIFO behind the ceiling. Both waiting bounds refuse rather than
  // queue forever: an unbounded queue converts an overloaded dependency into unbounded latency, which reads to
  // the caller as a hang. Abortable while queued, so a user stop never waits on calls ahead of it
  private acquire(key: string, signal?: AbortSignal): Promise<void> {
    const state = this.stateFor(key);
    if (this.maxConcurrent <= 0 || state.active < this.maxConcurrent) {
      state.active += 1;
      return Promise.resolve();
    }

    if (this.maxQueued > 0 && state.waiters.length >= this.maxQueued) {
      return Promise.reject(
        new BulkheadRejectedError(key, "queue-full", `${this.maxQueued} call(s) already waiting`)
      );
    }

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = {
        admit: () => {
          detach();
          state.active += 1;
          resolve();
        },
        abort: () => {
          detach();
          reject(new BulkheadRejectedError(key, "cancelled", "cancelled while queued"));
        },
      };
      const detach = (): void => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", waiter.abort);
        const index = state.waiters.indexOf(waiter);
        if (index !== -1) state.waiters.splice(index, 1);
      };

      if (signal?.aborted) return waiter.abort();
      signal?.addEventListener("abort", waiter.abort, { once: true });
      if (this.maxWaitMs > 0) {
        timer = setTimeout(() => {
          detach();
          reject(new BulkheadRejectedError(key, "timeout", `waited ${this.maxWaitMs}ms for a permit`));
        }, this.maxWaitMs);
      }
      state.waiters.push(waiter);
    });
  }

  // the freed permit is handed straight to the next waiter, so a later arrival can never jump the queue
  private release(key: string): void {
    const state = this.keys.get(key);
    if (!state) return;
    state.active -= 1;

    const next = state.waiters.shift();
    if (next) return next.admit();
    this.pruneIfIdle(key, state);
  }

  // ---------------------------------------------------------------------------

  private stateFor(key: string): KeyState {
    const existing = this.keys.get(key);
    if (existing) return existing;
    const state: KeyState = { consecutiveFailures: 0, openedAt: null, active: 0, waiters: [] };
    this.keys.set(key, state);
    return state;
  }

  // entries are transient: one survives only while a call is in flight or the breaker still remembers something
  private pruneIfIdle(key: string, state: KeyState): void {
    if (
      state.active === 0 &&
      state.waiters.length === 0 &&
      state.consecutiveFailures === 0 &&
      state.openedAt === null
    ) {
      this.keys.delete(key);
    }
  }

  private notify(notice: ResilienceNotice): void {
    try {
      this.onNotice?.(notice);
    } catch {
      // a throwing observer must never turn into a failure of the call it was observing
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
}
