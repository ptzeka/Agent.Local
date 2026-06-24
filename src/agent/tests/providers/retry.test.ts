import { describe, expect, jest, test } from "@jest/globals";

import { retryTransient, isTransientError } from "../../src/agent/providers/retry.js";

// baseDelayMs kept tiny so the jittered backoff is sub-millisecond — the tests assert call counts and outcomes,
// not timing, so there's no need to burn real wall-clock on the waits.
const FAST = { baseDelayMs: 1 } as const;

// a transient error shaped like the SDKs throw: a numeric HTTP status the classifier reads off `.status`
function transient(status = 503): Error & { status: number } {
  return Object.assign(new Error(`Provider failed: ${status} UNAVAILABLE`), { status });
}

describe("isTransientError", () => {
  test("classifies retryable HTTP statuses by numeric .status", () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(isTransientError(Object.assign(new Error("x"), { status }))).toBe(true);
    }
  });

  test("classifies retryable cases from the message when no numeric status is exposed", () => {
    expect(isTransientError(new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}'))).toBe(true);
    expect(isTransientError(new Error("429 RESOURCE_EXHAUSTED"))).toBe(true);
    expect(isTransientError(new Error("the model is overloaded, try again"))).toBe(true);
    expect(isTransientError(new Error("500 INTERNAL"))).toBe(true);
  });

  test("treats terminal failures as non-transient", () => {
    expect(isTransientError(Object.assign(new Error("bad request"), { status: 400 }))).toBe(false);
    expect(isTransientError(Object.assign(new Error("unauthorized"), { status: 401 }))).toBe(false);
    expect(isTransientError(new Error("model not found"))).toBe(false);
  });
});

describe("retryTransient", () => {
  test("returns the result without retrying when the call succeeds", async () => {
    const fn = jest.fn(async () => "ok");
    await expect(retryTransient(fn, FAST)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries a transient failure and returns once it succeeds", async () => {
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(transient(503))
      .mockRejectedValueOnce(transient(429))
      .mockResolvedValueOnce("recovered");
    await expect(retryTransient(fn, { ...FAST, maxAttempts: 3 })).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("stops at maxAttempts and rethrows the original error on a persistent outage", async () => {
    const err = transient(503);
    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(err);
    await expect(retryTransient(fn, { ...FAST, maxAttempts: 3 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("does not retry a terminal (non-transient) error", async () => {
    const err = Object.assign(new Error("bad model"), { status: 400 });
    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(err);
    await expect(retryTransient(fn, FAST)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("honours a shouldRetry veto (e.g. a stream that already emitted tokens)", async () => {
    const err = transient(503);
    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(err);
    await expect(retryTransient(fn, { ...FAST, shouldRetry: () => false })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("does not attempt another try once the signal is aborted", async () => {
    const controller = new AbortController();
    // abort as the first attempt fails, so the post-failure guard short-circuits before a second try
    const err = transient(503);
    const fn = jest.fn<() => Promise<string>>().mockImplementation(async () => {
      controller.abort();
      throw err;
    });
    await expect(retryTransient(fn, { ...FAST, maxAttempts: 5, signal: controller.signal })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
