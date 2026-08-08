import { describe, expect, test } from "@jest/globals";

import { DispatchTracker } from "../../src/agent/synthetic-mcp/dispatch-tracker.js";

describe("DispatchTracker admission", () => {
  test("counts each admitted call toward the per-turn cap", () => {
    const tracker = new DispatchTracker(2, 0);

    expect(tracker.reserve("filesagent")).toEqual({ ok: true });
    expect(tracker.reserve("filesagent")).toEqual({ ok: true });
    expect(tracker.reserve("filesagent")).toMatchObject({ ok: false });
    expect(tracker.count).toBe(2);
  });

  // the cap is per agent so one agent stuck in a loop cannot spend another's budget
  test("each agent gets its own budget", () => {
    const tracker = new DispatchTracker(1, 0);

    expect(tracker.reserve("filesagent")).toEqual({ ok: true });
    expect(tracker.reserve("filesagent")).toMatchObject({ ok: false });
    expect(tracker.reserve("excelagent")).toEqual({ ok: true });
  });

  test("a role's own cap overrides the turn-wide default", () => {
    const tracker = new DispatchTracker(1, 0);

    expect(tracker.reserve("filesagent", 2)).toEqual({ ok: true });
    expect(tracker.reserve("filesagent", 2)).toEqual({ ok: true });
    expect(tracker.reserve("filesagent", 2)).toMatchObject({ ok: false });
  });

  // a failing agent that kept its budget could loop forever, so the reservation is spent either way
  test("a call that goes on to fail still spent its budget", () => {
    const tracker = new DispatchTracker(1, 0);

    tracker.reserve("filesagent");
    tracker.settle(false);

    expect(tracker.reserve("filesagent")).toMatchObject({ ok: false });
  });

  test("the refusal names the agent and its limit", () => {
    const tracker = new DispatchTracker(1, 0);

    tracker.reserve("excelagent");

    expect(tracker.reserve("excelagent")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("excelagent"),
    });
  });
});

describe("DispatchTracker periodic check", () => {
  test("fires once per interval of SUCCEEDED calls", () => {
    const tracker = new DispatchTracker(10, 2);

    tracker.reserve("filesagent");
    tracker.settle(true);
    expect(tracker.dueForPeriodicCheck()).toBe(false);

    tracker.reserve("filesagent");
    tracker.settle(true);
    expect(tracker.dueForPeriodicCheck()).toBe(true);
    // consumed, so it does not fire again until the next interval
    expect(tracker.dueForPeriodicCheck()).toBe(false);
  });

  test("a failed call does not advance the interval", () => {
    const tracker = new DispatchTracker(10, 1);

    tracker.reserve("filesagent");
    tracker.settle(false);

    expect(tracker.dueForPeriodicCheck()).toBe(false);
  });
});
