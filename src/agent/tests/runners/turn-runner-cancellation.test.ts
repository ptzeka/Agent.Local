import { describe, expect, test } from "@jest/globals";

import {
  TurnRunner,
  type TurnDispatch,
  type TurnRunnerEvent,
} from "../../src/agent/runners/turn-runner.js";

// A turn is a child of a parent signal (the runtime scope): an ancestor abort must read exactly like a
// per-turn cancel — "cancelled", never "error" — and a turn whose signal is already aborted must never
// dispatch. Contentless runner; the inbox is modelled as an array the dispatch drains (see turn-runner.test).
describe("TurnRunner under a parent signal", () => {
  interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
  }
  function deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  interface Harness {
    runner: TurnRunner;
    push: (content: string) => void;
    drained: string[][];
    lastDone: () => Extract<TurnRunnerEvent, { type: "turn-done" }> | undefined;
  }

  function makeHarness(
    parentSignal: AbortSignal,
    gate?: (started: () => void, signal: AbortSignal) => Promise<unknown>
  ): Harness {
    const inbox: string[] = [];
    const drained: string[][] = [];
    const events: TurnRunnerEvent[] = [];
    let onStart: () => void = () => {};

    const dispatch: TurnDispatch = async (signal) => {
      if (signal.aborted) throw new Error("aborted before start");
      drained.push(inbox.splice(0));
      if (gate) await gate(onStart, signal);
      return { outcome: "satisfied" };
    };

    const runner = new TurnRunner(dispatch, {
      onEvent: (event) => events.push(event),
      parentSignal,
      shouldRun: () => inbox.length > 0,
    });

    return {
      runner,
      push: (content) => {
        inbox.push(content);
        runner.wake();
      },
      drained,
      lastDone: () =>
        [...events].reverse().find((event): event is Extract<TurnRunnerEvent, { type: "turn-done" }> =>
          event.type === "turn-done"
        ),
    };
  }

  // a gate that signals "started" then blocks until the abort signal fires
  function blockUntilAbort(started: () => void, signal: AbortSignal): Promise<never> {
    started();
    return new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }

  test("parent abort cancels the in-flight turn as 'cancelled', not 'error'", async () => {
    const parent = new AbortController();
    const started = deferred();
    const h = makeHarness(parent.signal, (signalStarted, signal) => {
      started.resolve();
      return blockUntilAbort(signalStarted, signal);
    });
    h.runner.start();

    h.push("long work");
    await started.promise;

    parent.abort("runtime shutdown");
    await h.runner.awaitIdle();

    expect(h.lastDone()).toMatchObject({ status: "cancelled" });
    await h.runner.stop();
  });

  test("a turn woken after the parent aborted is stillborn — it never dispatches", async () => {
    const parent = new AbortController();
    parent.abort();
    const h = makeHarness(parent.signal);
    h.runner.start();

    h.push("late");
    await h.runner.awaitIdle();

    expect(h.lastDone()).toMatchObject({ status: "cancelled" });
    expect(h.drained).toEqual([]); // the abort check fired before any drain
    await h.runner.stop();
  });

  test("per-turn cancel does NOT touch the parent signal", async () => {
    const parent = new AbortController();
    const started = deferred();
    const h = makeHarness(parent.signal, (signalStarted, signal) => {
      started.resolve();
      return blockUntilAbort(signalStarted, signal);
    });
    h.runner.start();

    h.push("doomed");
    await started.promise;

    expect(h.runner.cancelCurrent()).toBe(true);
    await h.runner.awaitIdle();

    expect(h.lastDone()).toMatchObject({ status: "cancelled" });
    expect(parent.signal.aborted).toBe(false);
    await h.runner.stop();
  });
});
