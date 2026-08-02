import { describe, expect, test } from "@jest/globals";

import {
  TurnRunner,
  type TurnDispatch,
  type TurnRunnerEvent,
  type TurnSource,
} from "../../src/agent/runners/turn-runner.js";

// The runner is contentless — prompt text lives in an InputInbox it never sees. These model that inbox as a
// plain array (push enqueues + wakes, the dispatch drains it) to exercise the scheduling contract:
// single-writer, wake/settle, and the empty-turn guard — not prompt content.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  runner: TurnRunner;
  // enqueue input and wake the runner — the InputInbox.push + onPush pair
  push: (content: string, source?: TurnSource) => void;
  // one entry per dispatch: the batch that turn drained
  drained: string[][];
  events: TurnRunnerEvent[];
  // high-water mark of concurrent dispatches — must stay 1 (single-writer)
  maxConcurrent: () => number;
}

interface HarnessOptions {
  // awaited while a dispatch is "in flight" (receives the drained batch); omit for an instant dispatch
  gate?: (batch: string[]) => Promise<void> | undefined;
  parentSignal?: AbortSignal;
  // simulate the running turn draining late input at its final iteration, so the inbox is empty by settle
  drainAgainBeforeReturn?: boolean;
  onEvent?: (event: TurnRunnerEvent) => void;
}

function makeHarness(opts: HarnessOptions = {}): Harness {
  const inbox: string[] = [];
  const drained: string[][] = [];
  const events: TurnRunnerEvent[] = [];
  let inFlight = 0;
  let maxConcurrent = 0;

  const dispatch: TurnDispatch = async (signal) => {
    // The orchestrator's first act each turn is an abort check — a turn whose
    // signal is already aborted never processes.
    if (signal.aborted) throw new Error("aborted before start");

    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    drained.push(inbox.splice(0));
    try {
      const gated = opts.gate?.(drained[drained.length - 1]);
      if (gated) {
        await Promise.race([
          gated,
          new Promise<never>((_, reject) =>
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
          ),
        ]);
      }
      if (opts.drainAgainBeforeReturn) inbox.splice(0);
      return { outcome: "satisfied" };
    } finally {
      inFlight -= 1;
    }
  };

  const runner = new TurnRunner(dispatch, {
    onEvent: (event) => {
      events.push(event);
      opts.onEvent?.(event);
    },
    parentSignal: opts.parentSignal,
    shouldRun: () => inbox.length > 0,
  });

  return {
    runner,
    push: (content, source) => {
      inbox.push(content);
      runner.wake(source);
    },
    drained,
    events,
    maxConcurrent: () => maxConcurrent,
  };
}

describe("TurnRunner", () => {
  test("a wake on an idle runner runs one turn that drains the queued input", async () => {
    const h = makeHarness();
    h.runner.start();

    h.push("one");
    await h.runner.awaitIdle();

    expect(h.drained).toEqual([["one"]]);
    expect(h.runner.isBusy).toBe(false);
    await h.runner.stop();
  });

  test("inputs that pile up before the turn starts drain together in one turn", async () => {
    const h = makeHarness();
    h.runner.start();

    // Both land in the inbox before the pump dispatches — natural coalescing.
    h.push("a");
    h.push("b");
    await h.runner.awaitIdle();

    expect(h.drained).toEqual([["a", "b"]]);
    await h.runner.stop();
  });

  test("input queued before start runs once started", async () => {
    const h = makeHarness();

    h.push("early");
    expect(h.drained).toEqual([]); // pump not running yet

    h.runner.start();
    await h.runner.awaitIdle();
    expect(h.drained).toEqual([["early"]]);
    await h.runner.stop();
  });

  test("single-writer: a wake during a running turn runs strictly after it", async () => {
    const started = deferred();
    const release = deferred();
    const h = makeHarness({
      gate: () => {
        started.resolve();
        return release.promise;
      },
    });
    h.runner.start();

    h.push("first");
    await started.promise; // "first" is draining; inbox now empty

    h.push("second"); // arrives mid-flight — must wait for the running turn
    expect(h.maxConcurrent()).toBe(1);

    release.resolve();
    await h.runner.awaitIdle();

    expect(h.drained).toEqual([["first"], ["second"]]);
    expect(h.maxConcurrent()).toBe(1);
    await h.runner.stop();
  });

  test("a wake whose content the running turn already drained does NOT spawn an empty turn", async () => {
    const started = deferred();
    const release = deferred();
    const h = makeHarness({
      drainAgainBeforeReturn: true, // the running turn picks up late input itself
      gate: () => {
        started.resolve();
        return release.promise;
      },
    });
    h.runner.start();

    h.push("a");
    await started.promise;
    h.push("b"); // the running turn will drain this before it settles

    release.resolve();
    await h.runner.awaitIdle();

    // Only one dispatch ran; "b" was consumed by it, so the trailing wake found
    // an empty inbox (shouldRun=false) and settled without an empty turn.
    expect(h.drained).toEqual([["a"]]);
    expect(h.runner.isBusy).toBe(false);
    await h.runner.stop();
  });

  test("input arriving after the final drain runs a follow-up turn (settle-race)", async () => {
    const started = deferred();
    const release = deferred();
    const h = makeHarness({
      gate: () => {
        started.resolve();
        return release.promise;
      },
    });
    h.runner.start();

    h.push("a");
    await started.promise;
    h.push("b"); // NOT drained by the running turn → must get its own turn

    release.resolve();
    await h.runner.awaitIdle();

    expect(h.drained).toEqual([["a"], ["b"]]);
    await h.runner.stop();
  });

  test("cancelCurrent aborts the in-flight turn (cancelled, not error) and the pump moves on", async () => {
    const started = deferred();
    const h = makeHarness({
      gate: () => {
        started.resolve();
        return new Promise<void>(() => {}); // only the abort ends it
      },
    });
    h.runner.start();

    expect(h.runner.cancelCurrent()).toBe(false); // nothing in flight yet

    h.push("long");
    await started.promise;
    expect(h.runner.cancelCurrent()).toBe(true);
    await h.runner.awaitIdle();

    const done = h.events.filter((event) => event.type === "turn-done");
    expect(done.at(-1)).toMatchObject({ status: "cancelled" });
    expect(h.runner.isBusy).toBe(false);
    await h.runner.stop();
  });

  test("cancelAll aborts the in-flight turn and drops a pending wake", async () => {
    const started = deferred();
    const h = makeHarness({
      gate: () => {
        started.resolve();
        return new Promise<void>(() => {});
      },
    });
    h.runner.start();

    h.push("long");
    await started.promise;

    expect(h.runner.cancelAll()).toBe(1);
    await h.runner.awaitIdle();
    expect(h.runner.isBusy).toBe(false);
    await h.runner.stop();
  });

  test("cancel(turnId) targets the live turn by its id, ignores unknown ids", async () => {
    const started = deferred();
    const h = makeHarness({
      gate: () => {
        started.resolve();
        return new Promise<void>(() => {});
      },
    });
    h.runner.start();

    h.push("work");
    await started.promise;

    const turnId = h.events.find((event) => event.type === "turn-start")!.turnId;
    expect(h.runner.cancel("bogus")).toBe(false);
    expect(h.runner.cancel(turnId)).toBe(true);
    await h.runner.awaitIdle();
    await h.runner.stop();
  });

  test("awaitIdle resolves immediately when idle, and only after in-flight work settles otherwise", async () => {
    const started = deferred();
    const release = deferred();
    const h = makeHarness({
      gate: () => {
        started.resolve();
        return release.promise;
      },
    });
    h.runner.start();

    await h.runner.awaitIdle(); // idle → must not hang

    h.push("work");
    await started.promise;

    let idleResolved = false;
    const idle = h.runner.awaitIdle().then(() => {
      idleResolved = true;
    });
    expect(idleResolved).toBe(false); // still in flight

    release.resolve();
    await idle;
    expect(h.runner.isBusy).toBe(false);
    await h.runner.stop();
  });

  test("graceful stop finishes the in-flight turn", async () => {
    const started = deferred();
    const release = deferred();
    const h = makeHarness({
      gate: () => {
        started.resolve();
        return release.promise;
      },
    });
    h.runner.start();

    h.push("long");
    await started.promise;

    const stopped = h.runner.stop();
    release.resolve();
    await stopped;

    expect(h.drained).toEqual([["long"]]);
    expect(h.runner.isBusy).toBe(false);
  });
});

describe("TurnRunner events", () => {
  test("emits turn-start then turn-done, carrying the wake's source", async () => {
    const h = makeHarness();
    h.runner.start();

    h.push("x", "api");
    await h.runner.awaitIdle();

    expect(h.events.map((event) => event.type)).toEqual(["turn-start", "turn-done"]);
    expect(h.events[0]).toMatchObject({ source: "api" });
    expect(h.events[1]).toMatchObject({ source: "api", status: "done" });
    await h.runner.stop();
  });

  test("a throwing listener does not break the pump", async () => {
    const inbox: string[] = [];
    const drained: string[] = [];
    const runner = new TurnRunner(
      async () => {
        drained.push(inbox.shift()!);
        return { outcome: "satisfied" };
      },
      {
        onEvent: () => {
          throw new Error("listener exploded");
        },
        shouldRun: () => inbox.length > 0,
      }
    );
    runner.start();

    inbox.push("one");
    runner.wake();
    await runner.awaitIdle();

    expect(drained).toEqual(["one"]);
    await runner.stop();
  });
});
