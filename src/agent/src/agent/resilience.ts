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

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
}

export class ResiliencePolicy {
  private readonly breakers = new Map<string, BreakerState>();

  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;
  private readonly onNotice?: (notice: ResilienceNotice) => void;

  constructor(private readonly port: string, options: ResilienceOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.breakerThreshold = options.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD;
    this.breakerCooldownMs = options.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
    this.onNotice = options.onNotice;
  }

  async run<T>(key: string, work: () => Promise<T>, options: RunOptions = {}): Promise<T> {
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

  // ---------------------------------------------------------------------------

  // ms remaining on an open breaker; 0 when the key may be called (closed, or the cooldown has elapsed
  // and this call is the half-open probe)
  private blockedFor(key: string): number {
    const state = this.breakers.get(key);
    if (!state?.openedAt) return 0;
    const remaining = this.breakerCooldownMs - (Date.now() - state.openedAt);
    return remaining > 0 ? remaining : 0;
  }

  private recordSuccess(key: string): void {
    const state = this.breakers.get(key);
    if (!state) return;
    // a successful half-open probe closes the breaker
    if (state.openedAt) {
      this.notify({ port: this.port, key, kind: "breaker-closed", message: `"${key}" recovered` });
    }
    this.breakers.delete(key);
  }

  private recordFailure(key: string): void {
    if (this.breakerThreshold <= 0) return;
    const state = this.breakers.get(key) ?? { consecutiveFailures: 0, openedAt: null };
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
    this.breakers.set(key, state);
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
