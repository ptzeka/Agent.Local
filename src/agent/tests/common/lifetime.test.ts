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

  /**
   * Fan-out at runtime scale: 5 levels deep, 5 children per scope — the shape
   * a deep dispatch/subsession tree takes. Every scope tallies its own abort
   * via a listener, so the count proves the signal FIRED everywhere, not just
   * that `cancelled` reads true.
   */
  describe("fan-out 5 deep x 5 wide", () => {
    const FAN_OUT = 5;
    const DEPTH = 5;

    interface Node {
      scope: CutoffScope;
      depth: number;
      aborted: boolean;
    }

    const buildTree = (): { root: Node; all: Node[] } => {
      const root: Node = { scope: new CutoffScope(), depth: 0, aborted: false };
      const all: Node[] = [root];
      let frontier = [root];
      for (let depth = 1; depth <= DEPTH; depth += 1) {
        const next: Node[] = [];
        for (const parent of frontier) {
          for (let i = 0; i < FAN_OUT; i += 1) {
            const node: Node = {
              scope: new CutoffScope(parent.scope.signal),
              depth,
              aborted: false,
            };
            node.scope.signal.addEventListener("abort", () => {
              node.aborted = true;
            });
            next.push(node);
            all.push(node);
          }
        }
        frontier = next;
      }
      return { root, all };
    };

    // 1 + 5 + 25 + 125 + 625 + 3125
    const TOTAL = 3906;

    test("root cancel tallies an abort on every descendant", () => {
      const { root, all } = buildTree();
      expect(all).toHaveLength(TOTAL);
      expect(all.some((node) => node.scope.cancelled)).toBe(false);

      root.scope.cancel("cut-everything");

      const fired = all.filter((node) => node.aborted || node === root);
      expect(fired).toHaveLength(TOTAL);
      expect(all.every((node) => node.scope.cancelled)).toBe(true);
    });

    test("mid-tree cancel tallies exactly its own subtree", () => {
      const { all } = buildTree();
      const branch = all.find((node) => node.depth === 2)!;
      branch.scope.cancel("cut-branch");

      // A depth-2 node owns itself + 3 levels below: 1 + 5 + 25 + 125.
      const cancelled = all.filter((node) => node.scope.cancelled);
      expect(cancelled).toHaveLength(156);
      expect(cancelled.every((node) => node.depth >= 2)).toBe(true);
      expect(all.filter((node) => node.aborted)).toHaveLength(156);
    });
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
