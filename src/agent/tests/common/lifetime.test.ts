import { describe, expect, test } from "@jest/globals";

import { CutoffScope, settledWithin } from "../../src/common/lifetime.js";

/**
 * The cancellation chain semantics: right-cutting (a cancel reaches every
 * descendant, never the parent or siblings), stillborn late joiners, and the
 * bounded-wait helper shutdown paths rely on.
 */
describe("CutoffScope", () => {
  test("cancel propagates to descendants only", () => {
    const root = new CutoffScope();
    const middle = new CutoffScope(root.signal);
    const sibling = new CutoffScope(root.signal);
    const leaf = new CutoffScope(middle.signal);

    middle.cancel("stop");

    expect(middle.cancelled).toBe(true);
    expect(leaf.cancelled).toBe(true);
    expect(root.cancelled).toBe(false);
    expect(sibling.cancelled).toBe(false);
  });

  test("root cancel reaches every layer", () => {
    const root = new CutoffScope();
    const middle = new CutoffScope(root.signal);
    const leaf = new CutoffScope(middle.signal);

    root.cancel();

    expect(root.cancelled).toBe(true);
    expect(middle.cancelled).toBe(true);
    expect(leaf.cancelled).toBe(true);
  });

  test("a scope created under a cancelled parent is born aborted", () => {
    const root = new CutoffScope();
    root.cancel();

    const lateChild = new CutoffScope(root.signal);
    expect(lateChild.cancelled).toBe(true);
  });

  test("signal fires abort listeners down the chain", () => {
    const root = new CutoffScope();
    const child = new CutoffScope(root.signal);

    let fired = false;
    child.signal.addEventListener("abort", () => {
      fired = true;
    });

    root.cancel();
    expect(fired).toBe(true);
  });

  test("cancel is idempotent and sticky", () => {
    const scope = new CutoffScope();
    scope.cancel("first");
    scope.cancel("second");
    expect(scope.cancelled).toBe(true);
  });
});

describe("settledWithin", () => {
  test("true when the work settles before the deadline", async () => {
    await expect(settledWithin(Promise.resolve("done"), 1000)).resolves.toBe(true);
  });

  test("true when the work rejects (shutdown must keep unwinding)", async () => {
    await expect(settledWithin(Promise.reject(new Error("boom")), 1000)).resolves.toBe(true);
  });

  test("false when the work outlives the deadline", async () => {
    const never = new Promise(() => {});
    await expect(settledWithin(never, 20)).resolves.toBe(false);
  });
});
