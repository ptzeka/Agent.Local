import { describe, expect, test } from "@jest/globals";

import { DispatchTracker, dispatchSignature } from "../../src/agent/synthetic-mcp/dispatch-tracker.js";

const ask = (tool: string, args: Record<string, unknown> = { path: "a.txt" }) =>
  dispatchSignature({ tool, args, intent: "write the file" });

describe("DispatchTracker admission", () => {
  test("counts each admitted dispatch toward the per-turn cap", () => {
    const tracker = new DispatchTracker(2, 0);

    expect(tracker.reserve(ask("write", { n: 1 }))).toEqual({ ok: true });
    expect(tracker.reserve(ask("write", { n: 2 }))).toEqual({ ok: true });
    expect(tracker.reserve(ask("write", { n: 3 }))).toMatchObject({ ok: false, kind: "capped" });
    expect(tracker.count).toBe(2);
  });

  test("a mutation that already succeeded this turn is refused as a duplicate", () => {
    const tracker = new DispatchTracker(5, 0);
    const signature = ask("write");

    expect(tracker.reserve(signature)).toEqual({ ok: true });
    tracker.settle(signature, true);

    expect(tracker.reserve(signature)).toMatchObject({ ok: false, kind: "duplicate" });
  });

  // the race the sequential tool loop used to hide: with a fanned-out round both asks are admitted before
  // either completes, so admission — not completion — has to be what decides the duplicate
  test("two concurrent identical asks: the second is refused before the first settles", () => {
    const tracker = new DispatchTracker(5, 0);
    const signature = ask("write");

    expect(tracker.reserve(signature)).toEqual({ ok: true });
    expect(tracker.reserve(signature)).toMatchObject({ ok: false, kind: "duplicate" });
  });

  test("a failed dispatch frees its signature so a corrected retry is allowed", () => {
    const tracker = new DispatchTracker(5, 0);
    const signature = ask("write");

    tracker.reserve(signature);
    tracker.settle(signature, false);

    expect(tracker.reserve(signature)).toEqual({ ok: true });
  });

  test("the cap is checked before the duplicate, so a capped turn reports the cap", () => {
    const tracker = new DispatchTracker(1, 0);
    const signature = ask("write");

    tracker.reserve(signature);
    tracker.settle(signature, true);

    expect(tracker.reserve(signature)).toMatchObject({ ok: false, kind: "capped" });
  });
});

describe("DispatchTracker periodic check", () => {
  test("fires once per interval of SUCCEEDED dispatches", () => {
    const tracker = new DispatchTracker(10, 2);

    tracker.reserve(ask("write", { n: 1 }));
    tracker.settle(ask("write", { n: 1 }), true);
    expect(tracker.dueForPeriodicCheck()).toBe(false);

    tracker.reserve(ask("write", { n: 2 }));
    tracker.settle(ask("write", { n: 2 }), true);
    expect(tracker.dueForPeriodicCheck()).toBe(true);
    // consumed, so it does not fire again until the next interval
    expect(tracker.dueForPeriodicCheck()).toBe(false);
  });

  test("a failed dispatch does not advance the interval", () => {
    const tracker = new DispatchTracker(10, 1);

    tracker.reserve(ask("write"));
    tracker.settle(ask("write"), false);

    expect(tracker.dueForPeriodicCheck()).toBe(false);
  });
});
