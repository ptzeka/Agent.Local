import { describe, expect, jest, test } from "@jest/globals";

import { BreakerOpenError, BulkheadRejectedError, ResiliencePolicy, type ResilienceNotice } from "../src/agent/resilience.js";
import { ResilientProvider } from "../src/agent/providers/resilient-provider.js";
import { ScopedToolClient } from "../src/agent/scoped-tool-client.js";
import type { ChatOptions, ChatResponse, LLMProvider } from "../src/agent/providers/provider.js";

// baseDelayMs kept tiny so the jittered backoff is sub-millisecond: these assert behaviour, not timing
const FAST = { baseDelayMs: 1 } as const;

function transient(status = 503): Error & { status: number } {
  return Object.assign(new Error(`upstream said ${status}`), { status });
}

describe("ResiliencePolicy retry", () => {
  test("retries a transient failure and announces every attempt", async () => {
    const notices: ResilienceNotice[] = [];
    const policy = new ResiliencePolicy("tool", { ...FAST, onNotice: (n) => notices.push(n) });
    let calls = 0;
    const work = async () => {
      calls += 1;
      if (calls < 3) throw transient();
      return "ok";
    };

    await expect(policy.run("fsmcp", work)).resolves.toBe("ok");
    expect(calls).toBe(3);
    // a silent retry loop is indistinguishable from a slow dependency
    expect(notices.filter((n) => n.kind === "retry")).toHaveLength(2);
  });

  test("a terminal failure is not retried", async () => {
    const policy = new ResiliencePolicy("tool", FAST);
    const work = jest.fn(async () => {
      throw Object.assign(new Error("bad request"), { status: 400 });
    });

    await expect(policy.run("fsmcp", work)).rejects.toThrow("bad request");
    expect(work).toHaveBeenCalledTimes(1);
  });

  test("an abort during backoff stops immediately", async () => {
    const policy = new ResiliencePolicy("tool", { baseDelayMs: 5_000 });
    const controller = new AbortController();
    const work = jest.fn(async () => {
      controller.abort();
      throw transient();
    });

    await expect(policy.run("fsmcp", work, { signal: controller.signal })).rejects.toThrow();
    expect(work).toHaveBeenCalledTimes(1);
  });
});

describe("ResiliencePolicy circuit breaker", () => {
  const alwaysFails = async () => {
    throw transient();
  };

  test("opens after N consecutive transient failures, then fails fast without calling through", async () => {
    const policy = new ResiliencePolicy("tool", {
      ...FAST,
      maxAttempts: 1,
      breakerThreshold: 2,
      breakerCooldownMs: 60_000,
    });

    await expect(policy.run("deadmcp", alwaysFails)).rejects.toThrow("upstream");
    await expect(policy.run("deadmcp", alwaysFails)).rejects.toThrow("upstream");

    const probe = jest.fn(alwaysFails);
    await expect(policy.run("deadmcp", probe)).rejects.toBeInstanceOf(BreakerOpenError);
    // the point of the breaker: a dead server stops burning an attempt on every iteration
    expect(probe).not.toHaveBeenCalled();
  });

  test("a healthy key is unaffected by another key's breaker", async () => {
    const policy = new ResiliencePolicy("tool", { ...FAST, maxAttempts: 1, breakerThreshold: 1 });
    await expect(policy.run("deadmcp", alwaysFails)).rejects.toThrow();

    await expect(policy.run("fsmcp", async () => "fine")).resolves.toBe("fine");
  });

  test("a successful half-open probe closes the breaker", async () => {
    const notices: ResilienceNotice[] = [];
    const policy = new ResiliencePolicy("tool", {
      ...FAST,
      maxAttempts: 1,
      breakerThreshold: 1,
      // already elapsed by the time the next call lands, so that call IS the half-open probe
      breakerCooldownMs: 0,
      onNotice: (n) => notices.push(n),
    });

    await expect(policy.run("flaky", alwaysFails)).rejects.toThrow();
    await expect(policy.run("flaky", async () => "recovered")).resolves.toBe("recovered");

    expect(notices.map((n) => n.kind)).toContain("breaker-open");
    expect(notices.map((n) => n.kind)).toContain("breaker-closed");
  });

  test("terminal failures never open the breaker on a healthy dependency", async () => {
    const policy = new ResiliencePolicy("tool", { ...FAST, maxAttempts: 1, breakerThreshold: 2 });
    const terminal = async () => {
      throw Object.assign(new Error("schema mismatch"), { status: 400 });
    };

    await expect(policy.run("fsmcp", terminal)).rejects.toThrow();
    await expect(policy.run("fsmcp", terminal)).rejects.toThrow();
    await expect(policy.run("fsmcp", async () => "still fine")).resolves.toBe("still fine");
  });
});

// ---------------------------------------------------------------------------
// The MODEL port
// ---------------------------------------------------------------------------

// a backend containing NO resilience code of its own — exactly what a newly added provider looks like
class BareProvider implements LLMProvider {
  readonly providerName = "bare";
  readonly modelId = "test-model";
  readonly supportsNativeTools = true;
  calls = 0;

  constructor(private readonly behaviour: (call: number, options: ChatOptions) => ChatResponse) {}

  async chat(_messages: never[], options: ChatOptions): Promise<ChatResponse> {
    this.calls += 1;
    return this.behaviour(this.calls, options);
  }
}

const reply = (content: string): ChatResponse => ({
  message: { role: "assistant", content },
  hasToolCalls: false,
});

describe("ResilientProvider", () => {
  test("a provider with no retry code of its own still retries a transient failure", async () => {
    const inner = new BareProvider((call) => {
      if (call < 2) throw transient();
      return reply("done");
    });
    const provider = new ResilientProvider(inner, new ResiliencePolicy("model", FAST));

    const response = await provider.chat([], { tools: [] });
    expect(response.message.content).toBe("done");
    expect(inner.calls).toBe(2);
  });

  test("never re-runs a call that already streamed tokens — a retry would double-emit", async () => {
    const inner = new BareProvider((_call, options) => {
      options.onDelta?.("partial ");
      throw transient();
    });
    const provider = new ResilientProvider(inner, new ResiliencePolicy("model", FAST));
    const seen: string[] = [];

    await expect(
      provider.chat([], { tools: [], onDelta: (delta) => seen.push(delta) })
    ).rejects.toThrow();
    expect(inner.calls).toBe(1);
    expect(seen).toEqual(["partial "]);
  });

  test("passes the backend's identity through unchanged", () => {
    const inner = new BareProvider(() => reply(""));
    const provider = new ResilientProvider(inner, new ResiliencePolicy("model", FAST));

    expect(provider.providerName).toBe("bare");
    expect(provider.modelId).toBe("test-model");
    expect(provider.supportsNativeTools).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The TOOL port
// ---------------------------------------------------------------------------

function fakeClient(name: string, callTool: () => Promise<{ isError: boolean; content: string }>) {
  return {
    name,
    listTools: () => [{ name: `${name}__do`, description: "", inputSchema: { type: "object" } }],
    callTool,
  } as never;
}

describe("ScopedToolClient degradation", () => {
  test("a throw from the transport becomes a tool-error result, not a dead turn", async () => {
    const client = new ScopedToolClient([
      fakeClient("fsmcp", async () => {
        throw new Error("transport closed");
      }),
    ]);

    const result = await client.callTool("fsmcp__do", {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("[tool-error]");
    expect(result.content).toContain("transport closed");
  });

  test("a user stop still unwinds — it is a cancelled turn, not a bad tool", async () => {
    const controller = new AbortController();
    const client = new ScopedToolClient([
      fakeClient("fsmcp", async () => {
        controller.abort();
        throw new Error("aborted");
      }),
    ]);

    await expect(client.callTool("fsmcp__do", {}, undefined, controller.signal)).rejects.toThrow(
      "aborted"
    );
  });

  test("with a policy attached, a transient tool failure is retried before degrading", async () => {
    let calls = 0;
    const client = new ScopedToolClient(
      [
        fakeClient("fsmcp", async () => {
          calls += 1;
          if (calls < 2) throw transient();
          return { isError: false, content: "ok" };
        }),
      ],
      new ResiliencePolicy("tool", FAST)
    );

    const result = await client.callTool("fsmcp__do", {});
    expect(result.content).toBe("ok");
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Bulkhead
// ---------------------------------------------------------------------------

// a round's tool calls run concurrently and a role-agent call spawns a whole child runtime, so the per-key
// ceiling is what stops one server from being handed more work than it can carry
describe("ResiliencePolicy bulkhead", () => {
  // a work function that parks until released, reporting how many ran at once
  function gated() {
    const releases: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    const work = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return "ok";
    };
    return {
      work,
      releaseAll: () => {
        while (releases.length > 0) releases.shift()!();
      },
      started: () => releases.length,
      peak: () => peak,
    };
  }

  test("admits up to the ceiling and queues the rest", async () => {
    const policy = new ResiliencePolicy("tool", { ...FAST, maxConcurrent: 2 });
    const g = gated();

    const all = Promise.all([1, 2, 3, 4].map(() => policy.run("filesagent", g.work)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(g.started()).toBe(2);

    g.releaseAll();
    await new Promise((resolve) => setImmediate(resolve));
    g.releaseAll();
    await expect(all).resolves.toEqual(["ok", "ok", "ok", "ok"]);
    expect(g.peak()).toBe(2);
  });

  test("the ceiling is per key, so a slow server never blocks a different one", async () => {
    const policy = new ResiliencePolicy("tool", { ...FAST, maxConcurrent: 1 });
    const g = gated();

    const all = Promise.all([
      policy.run("filesagent", g.work),
      policy.run("excelagent", g.work),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(g.started()).toBe(2);

    g.releaseAll();
    await expect(all).resolves.toEqual(["ok", "ok"]);
  });

  test("a thrown call still releases its permit", async () => {
    const policy = new ResiliencePolicy("tool", { ...FAST, maxConcurrent: 1, breakerThreshold: 0 });
    // not transient, so it fails without burning retries
    await expect(policy.run("fsmcp", async () => { throw new Error("bad input"); })).rejects.toThrow("bad input");
    await expect(policy.run("fsmcp", async () => "ok")).resolves.toBe("ok");
  });

  test("a queued call is cancellable, so a stop never waits on the work ahead of it", async () => {
    const policy = new ResiliencePolicy("tool", { ...FAST, maxConcurrent: 1 });
    const g = gated();
    const controller = new AbortController();

    const running = policy.run("filesagent", g.work);
    const queued = policy.run("filesagent", g.work, { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));

    controller.abort();
    await expect(queued).rejects.toThrow("queued");
    // typed like the breaker's refusal so a port can tell "never ran" from "ran and failed"
    await expect(queued).rejects.toMatchObject({ reason: "cancelled", key: "filesagent" });

    g.releaseAll();
    await expect(running).resolves.toBe("ok");
  });

  test("a full queue refuses instead of parking behind it", async () => {
    const policy = new ResiliencePolicy("tool", { ...FAST, maxConcurrent: 1, maxQueued: 1 });
    const g = gated();

    const running = policy.run("filesagent", g.work);
    const queued = policy.run("filesagent", g.work);
    const refused = policy.run("filesagent", g.work);

    await expect(refused).rejects.toBeInstanceOf(BulkheadRejectedError);
    await expect(refused).rejects.toMatchObject({ reason: "queue-full" });

    g.releaseAll();
    await new Promise((resolve) => setImmediate(resolve));
    g.releaseAll();
    await expect(Promise.all([running, queued])).resolves.toEqual(["ok", "ok"]);
  });

  test("a permit wait that runs out refuses rather than queueing forever", async () => {
    const policy = new ResiliencePolicy("tool", { ...FAST, maxConcurrent: 1, maxWaitMs: 5 });
    const g = gated();

    const running = policy.run("fsmcp", g.work);
    const queued = policy.run("fsmcp", g.work);

    await expect(queued).rejects.toMatchObject({ reason: "timeout" });

    g.releaseAll();
    await expect(running).resolves.toBe("ok");
  });

  test("a refused call never took a permit, so the ceiling still admits the next arrival", async () => {
    const policy = new ResiliencePolicy("tool", { ...FAST, maxConcurrent: 1, maxQueued: 0, maxWaitMs: 5 });
    const g = gated();

    const running = policy.run("fsmcp", g.work);
    await expect(policy.run("fsmcp", g.work)).rejects.toMatchObject({ reason: "timeout" });

    g.releaseAll();
    await expect(running).resolves.toBe("ok");
    await expect(policy.run("fsmcp", async () => "ok")).resolves.toBe("ok");
  });

  test("no ceiling configured means no limit", async () => {
    const policy = new ResiliencePolicy("tool", FAST);
    const g = gated();

    const all = Promise.all([1, 2, 3, 4, 5].map(() => policy.run("fsmcp", g.work)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(g.started()).toBe(5);

    g.releaseAll();
    await expect(all).resolves.toHaveLength(5);
  });
});
