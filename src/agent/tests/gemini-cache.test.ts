import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

import { GeminiProvider, cacheExpiryMs } from "../src/agent/providers/gemini-provider.js";

/**
 * Gemini context-cache lifecycle tests.
 *
 * The provider memoizes one server-side cache entry (system + tools). Entries
 * are deleted server-side at expireTime; reusing a lapsed name fails the
 * request outright. These lock in that the memo is keyed on BOTH content and
 * freshness: a fresh entry is reused, an expired or content-changed one is
 * recreated, and a failed create falls back to inline (and retries later).
 */

const NOW = Date.parse("2026-06-10T12:00:00Z");

/** A system instruction + tool set big enough to be cache-worthy in spirit. */
const SYSTEM = "You are the orchestrator.";
const TOOLS = [{ functionDeclarations: [{ name: "read_file" }] }];

function providerWithStubbedCaches(create: jest.Mock) {
  const provider = new GeminiProvider({
    apiKey: "test-key",
    model: "gemini-2.5-flash-lite",
    supportsTools: true,
  } as never);
  // Replace the real SDK client with a stub; only caches.create is exercised.
  (provider as unknown as { client: unknown }).client = { caches: { create } };
  return provider;
}

function ensureCache(provider: GeminiProvider, system: string | undefined, tools: unknown) {
  return (
    provider as unknown as {
      ensureCache(s: string | undefined, t: unknown): Promise<string | undefined>;
    }
  ).ensureCache(system, tools);
}

describe("cacheExpiryMs", () => {
  test("prefers the server-reported expireTime", () => {
    const expireTime = "2026-06-10T12:05:00Z";
    expect(cacheExpiryMs(expireTime, NOW)).toBe(Date.parse(expireTime));
  });

  test("falls back to now + TTL when expireTime is absent", () => {
    expect(cacheExpiryMs(undefined, NOW)).toBe(NOW + 300_000);
  });

  test("falls back to now + TTL when expireTime is unparseable", () => {
    expect(cacheExpiryMs("not-a-date", NOW)).toBe(NOW + 300_000);
  });
});

describe("GeminiProvider cache lifecycle", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("reuses a fresh cache entry without re-creating", async () => {
    const create = jest.fn(async () => ({
      name: "cachedContents/fresh",
      expireTime: new Date(NOW + 300_000).toISOString(),
    })) as jest.Mock;
    const provider = providerWithStubbedCaches(create);

    expect(await ensureCache(provider, SYSTEM, TOOLS)).toBe("cachedContents/fresh");
    expect(await ensureCache(provider, SYSTEM, TOOLS)).toBe("cachedContents/fresh");
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("recreates once the entry is within the expiry margin", async () => {
    let serial = 0;
    const create = jest.fn(async () => ({
      name: `cachedContents/v${++serial}`,
      expireTime: new Date(Date.now() + 300_000).toISOString(),
    })) as jest.Mock;
    const provider = providerWithStubbedCaches(create);

    expect(await ensureCache(provider, SYSTEM, TOOLS)).toBe("cachedContents/v1");

    // 30s before expireTime is the margin boundary — past it, the memoized
    // name must NOT be reused (this was the bug: it was reused forever).
    jest.setSystemTime(NOW + 300_000 - 10_000);
    expect(await ensureCache(provider, SYSTEM, TOOLS)).toBe("cachedContents/v2");
    expect(create).toHaveBeenCalledTimes(2);
  });

  test("recreates when the system+tools key changes", async () => {
    let serial = 0;
    const create = jest.fn(async () => ({
      name: `cachedContents/v${++serial}`,
      expireTime: new Date(Date.now() + 300_000).toISOString(),
    })) as jest.Mock;
    const provider = providerWithStubbedCaches(create);

    expect(await ensureCache(provider, SYSTEM, TOOLS)).toBe("cachedContents/v1");
    expect(await ensureCache(provider, "Different system prompt.", TOOLS)).toBe(
      "cachedContents/v2"
    );
    expect(create).toHaveBeenCalledTimes(2);
  });

  test("falls back to inline on create failure and retries next call", async () => {
    const create = jest
      .fn(async () => {
        throw new Error("below minimum token count");
      })
      .mockImplementationOnce(async () => {
        throw new Error("below minimum token count");
      }) as jest.Mock;
    const provider = providerWithStubbedCaches(create);

    expect(await ensureCache(provider, SYSTEM, TOOLS)).toBeUndefined();

    // State was cleared, so the next call tries again rather than staying
    // permanently inline on a stale memo.
    create.mockImplementationOnce(async () => ({
      name: "cachedContents/recovered",
      expireTime: new Date(Date.now() + 300_000).toISOString(),
    }));
    expect(await ensureCache(provider, SYSTEM, TOOLS)).toBe("cachedContents/recovered");
  });
});
