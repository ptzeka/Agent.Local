import { describe, expect, test } from "@jest/globals";

import { TurnRunner, type RoundDispatch } from "../../src/agent/runners/turn-runner.js";

/**
 * TurnRunner scheduling semantics.
 *
 * The runner is tested as a pure scheduler: `dispatch` is a fake that records
 * calls and can be gated on a deferred, so each test controls exactly when a
 * round is "in flight". No orchestrator, providers, or timers involved.
 */

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

/** Dispatch that records contents and resolves immediately. */
function instantDispatch(calls: string[]): RoundDispatch {
  return async (content) => {
    calls.push(content);
    return { outcome: "satisfied" };
  };
}

describe("TurnRunner", () => {
  test("runs queued turns in FIFO order", async () => {
    const calls: string[] = [];
    const runner = new TurnRunner(instantDispatch(calls));
    runner.start();

    const first = runner.submit({ content: "one", source: "user" });
    const second = runner.submit({ content: "two", source: "user" });

    const [firstTurn, secondTurn] = await Promise.all([first.settled, second.settled]);
    expect(calls).toEqual(["one", "two"]);
    expect(firstTurn.status).toBe("done");
    expect(secondTurn.status).toBe("done");
    await runner.stop();
  });

  test("submissions queued before start run once started (resume contract)", async () => {
    const calls: string[] = [];
    const runner = new TurnRunner(instantDispatch(calls));

    const receipt = runner.submit({ content: "early", source: "user" });
    expect(calls).toEqual([]); // pump not running yet

    runner.start();
    const settled = await receipt.settled;
    expect(calls).toEqual(["early"]);
    expect(settled.status).toBe("done");
    await runner.stop();
  });

  test("preferMidTurn appends a round to the RUNNING turn and settles with it", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const calls: string[] = [];
    const runner = new TurnRunner(async (content) => {
      calls.push(content);
      if (content === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return { outcome: "satisfied" };
    });
    runner.start();

    const userReceipt = runner.submit({ content: "first", source: "user" });
    await firstStarted.promise;

    const feedbackReceipt = runner.submit({
      content: "feedback",
      source: "subsession",
      preferMidTurn: true,
    });

    expect(feedbackReceipt.placement).toBe("mid-turn-round");
    expect(feedbackReceipt.turnId).toBe(userReceipt.turnId);

    releaseFirst.resolve();
    const settled = await userReceipt.settled;
    expect(settled.status).toBe("done");
    expect(settled.rounds.map((round) => round.content)).toEqual(["first", "feedback"]);
    expect(calls).toEqual(["first", "feedback"]);
    await runner.stop();
  });

  test("preferMidTurn with no running turn falls back to a new queued turn", async () => {
    const calls: string[] = [];
    const runner = new TurnRunner(instantDispatch(calls));
    runner.start();

    const receipt = runner.submit({ content: "wake", source: "subsession", preferMidTurn: true });
    expect(receipt.placement).toBe("new-turn");
    const settled = await receipt.settled;
    expect(settled.status).toBe("done");
    expect(calls).toEqual(["wake"]);
    await runner.stop();
  });

  test("coalesceKey collapses onto a PENDING turn instead of growing the queue", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const calls: string[] = [];
    const runner = new TurnRunner(async (content) => {
      calls.push(content);
      if (content === "busy") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return { outcome: "satisfied" };
    });
    runner.start();

    runner.submit({ content: "busy", source: "user" });
    await firstStarted.promise;

    // Two reports arrive while the user turn runs; preferMidTurn is OFF here
    // so they must queue — and the second coalesces into the first's turn.
    const reportA = runner.submit({ content: "report-a", source: "subsession", coalesceKey: "report" });
    const reportB = runner.submit({ content: "report-b", source: "subsession", coalesceKey: "report" });

    expect(reportA.placement).toBe("new-turn");
    expect(reportB.placement).toBe("coalesced-round");
    expect(reportB.turnId).toBe(reportA.turnId);
    expect(runner.pendingCount).toBe(1);

    releaseFirst.resolve();
    const settled = await reportA.settled;
    expect(settled.rounds.map((round) => round.content)).toEqual(["report-a", "report-b"]);
    expect(calls).toEqual(["busy", "report-a", "report-b"]);
    await runner.stop();
  });

  test("a failing round fails the turn, skips later rounds, and the pump continues", async () => {
    const calls: string[] = [];
    const runner = new TurnRunner(async (content) => {
      calls.push(content);
      if (content === "boom") throw new Error("dispatch exploded");
      return { outcome: "satisfied" };
    });

    // Build a 2-round turn via coalescing BEFORE the pump starts, plus a
    // follow-up turn that must still run after the failure.
    const failing = runner.submit({ content: "boom", source: "subsession", coalesceKey: "k" });
    runner.submit({ content: "never-runs", source: "subsession", coalesceKey: "k" });
    const followUp = runner.submit({ content: "after", source: "user" });

    runner.start();
    const [failedTurn, followUpTurn] = await Promise.all([failing.settled, followUp.settled]);

    expect(failedTurn.status).toBe("error");
    expect(failedTurn.rounds[0].status).toBe("error");
    expect(failedTurn.rounds[0].error).toContain("dispatch exploded");
    expect(failedTurn.rounds[1].status).toBe("skipped");
    expect(followUpTurn.status).toBe("done");
    expect(calls).toEqual(["boom", "after"]); // "never-runs" was never dispatched
    await runner.stop();
  });

  test("cancelling a pending turn settles it without dispatching", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const calls: string[] = [];
    const runner = new TurnRunner(async (content) => {
      calls.push(content);
      if (content === "busy") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return { outcome: "satisfied" };
    });
    runner.start();

    runner.submit({ content: "busy", source: "user" });
    await firstStarted.promise;
    const doomed = runner.submit({ content: "doomed", source: "user" });

    expect(runner.cancel(doomed.turnId)).toBe(true);
    const settled = await doomed.settled;
    expect(settled.status).toBe("cancelled");
    expect(settled.rounds[0].status).toBe("skipped");

    releaseFirst.resolve();
    await runner.stop();
    expect(calls).toEqual(["busy"]);
  });

  test("cancelCurrent aborts the in-flight turn; the pump moves on to the next", async () => {
    const started = deferred();
    const calls: string[] = [];
    const runner = new TurnRunner(async (content, signal) => {
      calls.push(content);
      if (content === "long") {
        started.resolve();
        // Honour the abort signal the way a real provider call would.
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return { outcome: "satisfied" };
    });
    runner.start();

    expect(runner.cancelCurrent()).toBe(false); // nothing in flight yet

    const longReceipt = runner.submit({ content: "long", source: "user" });
    const nextReceipt = runner.submit({ content: "next", source: "user" });
    await started.promise;

    expect(runner.cancelCurrent()).toBe(true);
    const [cancelled, next] = await Promise.all([longReceipt.settled, nextReceipt.settled]);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.rounds[0].status).toBe("cancelled"); // a stop, not an error
    expect(next.status).toBe("done");
    expect(calls).toEqual(["long", "next"]);
    await runner.stop();
  });

  test("cancelAll flushes pending turns and aborts the in-flight one", async () => {
    const started = deferred();
    const calls: string[] = [];
    const runner = new TurnRunner(async (content, signal) => {
      calls.push(content);
      if (content === "long") {
        started.resolve();
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return { outcome: "satisfied" };
    });
    runner.start();

    const inFlight = runner.submit({ content: "long", source: "user" });
    const queuedA = runner.submit({ content: "queued-a", source: "user" });
    const queuedB = runner.submit({ content: "queued-b", source: "subsession", coalesceKey: "report" });
    await started.promise;

    expect(runner.cancelAll()).toBe(3);
    const [current, a, b] = await Promise.all([inFlight.settled, queuedA.settled, queuedB.settled]);

    expect(current.status).toBe("cancelled");
    expect(a.status).toBe("cancelled");
    expect(b.status).toBe("cancelled");
    expect(calls).toEqual(["long"]); // queued turns never dispatched
    expect(runner.isBusy).toBe(false);
    await runner.stop();
  });

  test("awaitIdle resolves immediately when idle, and only after in-flight work settles otherwise", async () => {
    const started = deferred();
    const release = deferred();
    const runner = new TurnRunner(async () => {
      started.resolve();
      await release.promise;
      return { outcome: "satisfied" };
    });
    runner.start();

    await runner.awaitIdle(); // idle → must not hang

    const receipt = runner.submit({ content: "work", source: "user" });
    await started.promise;

    let idleResolved = false;
    const idle = runner.awaitIdle().then(() => {
      idleResolved = true;
    });
    expect(idleResolved).toBe(false); // still in flight

    release.resolve();
    await idle;
    expect(runner.isBusy).toBe(false);

    const settled = await receipt.settled;
    expect(settled.status).toBe("done");
    await runner.stop();
  });

  test("maxRoundsPerTurn spills appends into a new turn instead of growing forever", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const runner = new TurnRunner(
      async (content) => {
        if (content === "busy") {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return { outcome: "satisfied" };
      },
      { maxRoundsPerTurn: 1 }
    );
    runner.start();

    const userReceipt = runner.submit({ content: "busy", source: "user" });
    await firstStarted.promise;

    // The running turn is at its 1-round cap — the append must spill.
    const spilled = runner.submit({ content: "fb", source: "subsession", preferMidTurn: true });
    expect(spilled.placement).toBe("new-turn");
    expect(spilled.turnId).not.toBe(userReceipt.turnId);

    releaseFirst.resolve();
    await Promise.all([userReceipt.settled, spilled.settled]);
    await runner.stop();
  });

  test("snapshot projects current + pending turns with their rounds", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const runner = new TurnRunner(async (content) => {
      if (content === "busy") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return { outcome: "satisfied" };
    });
    runner.start();

    const running = runner.submit({ content: "busy", source: "user" });
    await firstStarted.promise;
    const waiting = runner.submit({ content: "waiting", source: "subsession", coalesceKey: "report" });

    const snapshot = runner.snapshot();
    expect(snapshot.current?.turnId).toBe(running.turnId);
    expect(snapshot.current?.status).toBe("running");
    expect(snapshot.current?.rounds[0].status).toBe("running");
    expect(snapshot.pending).toHaveLength(1);
    expect(snapshot.pending[0].coalesceKey).toBe("report");
    expect(snapshot.pending[0].rounds[0].content).toBe("waiting");

    releaseFirst.resolve();
    // Await BOTH turns: a graceful stop() leaves still-pending turns queued
    // (the resume contract), so isBusy is only false once the queue drained.
    await Promise.all([running.settled, waiting.settled]);
    await runner.stop();
    expect(runner.isBusy).toBe(false);
  });
});
