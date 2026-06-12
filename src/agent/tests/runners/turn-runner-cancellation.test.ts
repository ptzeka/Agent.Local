import { describe, expect, test } from "@jest/globals";

import { TurnRunner } from "../../src/agent/runners/turn-runner.js";

/**
 * Cancellation-chain semantics: turns are children of a parent signal
 * (the runtime scope). An ancestor abort must read exactly like a per-turn
 * cancel — "cancelled", never "error" — and must reach queued turns too.
 */
describe("TurnRunner under a parent signal", () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  test("parent abort cancels the in-flight turn as 'cancelled', not 'error'", async () => {
    const parent = new AbortController();
    const started = deferred();

    const runner = new TurnRunner(
      async (_content, signal) => {
        started.resolve();
        // Honour the abort the way a real provider call would.
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return { outcome: "satisfied" };
      },
      { parentSignal: parent.signal }
    );
    runner.start();

    const receipt = runner.submit({ content: "long work", source: "user" });
    await started.promise;

    parent.abort("runtime shutdown");
    const settled = await receipt.settled;

    expect(settled.status).toBe("cancelled");
    expect(settled.rounds[0].status).toBe("cancelled");
    await runner.stop();
  });

  test("parent abort reaches queued turns — they settle cancelled without dispatching", async () => {
    const parent = new AbortController();
    const calls: string[] = [];
    const started = deferred();

    const runner = new TurnRunner(
      async (content, signal) => {
        calls.push(content);
        started.resolve();
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return { outcome: "satisfied" };
      },
      { parentSignal: parent.signal }
    );
    runner.start();

    const inFlight = runner.submit({ content: "busy", source: "user" });
    await started.promise;
    const queued = runner.submit({ content: "waiting", source: "user" });

    parent.abort();
    const [current, next] = await Promise.all([inFlight.settled, queued.settled]);

    expect(current.status).toBe("cancelled");
    // The queued turn is promoted by the pump, sees its derived signal already
    // aborted, and skips every round — never dispatched.
    expect(next.status).toBe("cancelled");
    expect(next.rounds[0].status).toBe("skipped");
    expect(calls).toEqual(["busy"]);
    await runner.stop();
  });

  test("a turn submitted after the parent aborted is stillborn", async () => {
    const parent = new AbortController();
    parent.abort();
    const calls: string[] = [];

    const runner = new TurnRunner(
      async (content) => {
        calls.push(content);
        return { outcome: "satisfied" };
      },
      { parentSignal: parent.signal }
    );
    runner.start();

    const receipt = runner.submit({ content: "late", source: "user" });
    const settled = await receipt.settled;

    expect(settled.status).toBe("cancelled");
    expect(calls).toEqual([]);
    await runner.stop();
  });

  test("per-turn cancel still works and does NOT touch the parent or siblings", async () => {
    const parent = new AbortController();
    const started = deferred();

    const runner = new TurnRunner(
      async (content, signal) => {
        if (content === "doomed") {
          started.resolve();
          await new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return { outcome: "satisfied" };
      },
      { parentSignal: parent.signal }
    );
    runner.start();

    const doomed = runner.submit({ content: "doomed", source: "user" });
    const survivor = runner.submit({ content: "next", source: "user" });
    await started.promise;

    expect(runner.cancel(doomed.turnId)).toBe(true);
    const [cancelled, done] = await Promise.all([doomed.settled, survivor.settled]);

    expect(cancelled.status).toBe("cancelled");
    expect(done.status).toBe("done");
    expect(parent.signal.aborted).toBe(false);
    await runner.stop();
  });
});
