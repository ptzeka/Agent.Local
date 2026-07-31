// shared transient-failure retry for provider calls. A model endpoint under load answers 429/5xx with a
// "try again later" — a retryable blip, NOT a real failure — yet a single throw kills the whole turn (chat dies,
// a job step fails). This wraps the SDK call so transient errors are retried with backoff; everything terminal
// (auth, bad model, 4xx) still throws on the first try, and a persistent outage falls through after the last
// attempt so the caller's own failure handling (e.g. the runner's fail envelope) still runs.

// the SDKs surface an HTTP status either as a numeric `.status` on the error or only inside the message JSON
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

// depth bound: a cause chain is walked, not trusted — a cyclic or pathological chain must not hang classification
const MAX_CAUSE_DEPTH = 4;

export function isTransientError(err: unknown, depth = 0): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number" && TRANSIENT_STATUS.has(status)) return true;
  const message = err instanceof Error ? err.message : String(err);
  // fall back to the code/status string the providers embed in the error text when no numeric status is exposed
  if (/(^|\D)(429|500|502|503|504)(\D|$)/.test(message)) return true;
  if (/UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL|overloaded/i.test(message)) return true;
  // a port-level policy sees the provider's WRAPPED error, whose numeric status lives on the cause
  const cause = (err as { cause?: unknown })?.cause;
  return cause !== undefined && depth < MAX_CAUSE_DEPTH ? isTransientError(cause, depth + 1) : false;
}

export interface RetryOptions {
  // abort short-circuits both the wait and any further attempt: a user Stop must not be delayed by a pending retry
  signal?: AbortSignal;
  // total tries INCLUDING the first; defaults to 3 (so up to 2 retries)
  maxAttempts?: number;
  baseDelayMs?: number;
  // lets a caller veto a retry it can't safely repeat (e.g. a stream that already emitted tokens)
  shouldRetry?: (err: unknown) => boolean;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;

export async function retryTransient<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const shouldRetry = options.shouldRetry ?? isTransientError;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (options.signal?.aborted || attempt >= maxAttempts || !shouldRetry(err)) throw err;
      // full jitter on an exponential base so concurrent callers riding the same overload don't retry in lockstep
      const delay = Math.round(Math.random() * baseDelayMs * 2 ** (attempt - 1));
      await sleep(delay, options.signal);
    }
  }
}

// abortable wait: clears the timer and rejects the moment the signal fires, so a Stop during backoff returns at once
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
