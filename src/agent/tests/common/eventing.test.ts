import { describe, expect, test } from "@jest/globals";

import { Eventing, type EventMessage } from "../../src/common/eventing.js";

/**
 * Eventing semantics: standalone publish/subscribe with unsubscribe, and the
 * upward bubble across a parent -> c1 -> c2 chain — a leaf publish reaches the
 * leaf's subscribers first, then each ancestor's, in order, exactly once.
 */
describe("Eventing", () => {
  describe("standalone", () => {
    test("subscriber receives the published type and payload", () => {
      const bus = new Eventing();
      const seen: EventMessage[] = [];
      bus.subscribe((event) => seen.push(event));

      bus.publish("hello", { n: 1 });

      expect(seen).toEqual([{ type: "hello", payload: { n: 1 } }]);
    });

    test("payload defaults to an empty object", () => {
      const bus = new Eventing();
      const seen: EventMessage[] = [];
      bus.subscribe((event) => seen.push(event));

      bus.publish("ping");

      expect(seen).toEqual([{ type: "ping", payload: {} }]);
    });

    test("every subscriber fires, in registration order", () => {
      const bus = new Eventing();
      const order: string[] = [];
      bus.subscribe(() => order.push("a"));
      bus.subscribe(() => order.push("b"));

      bus.publish("x");

      expect(order).toEqual(["a", "b"]);
    });

    test("unsubscribe stops delivery without affecting others", () => {
      const bus = new Eventing();
      const order: string[] = [];
      const off = bus.subscribe(() => order.push("a"));
      bus.subscribe(() => order.push("b"));

      off();
      bus.publish("x");

      expect(order).toEqual(["b"]);
    });

    test("a channelled subscriber fires only for its event type", () => {
      const bus = new Eventing();
      const seen: EventMessage[] = [];
      bus.subscribe("ready", (event) => seen.push(event));

      bus.publish("busy", { n: 1 });
      bus.publish("ready", { n: 2 });
      bus.publish("done", { n: 3 });

      expect(seen).toEqual([{ type: "ready", payload: { n: 2 } }]);
    });

    test("a channelled subscription bubbles up the chain like a catch-all", () => {
      const parent = new Eventing();
      const child = new Eventing();
      parent.add(child);

      const seen: EventMessage[] = [];
      parent.subscribe("done", (event) => seen.push(event));

      child.publish("noise");
      child.publish("done", { ok: true });

      expect(seen).toEqual([{ type: "done", payload: { ok: true } }]);
    });

    test("a throwing subscriber does not break the producer or other subscribers", () => {
      const bus = new Eventing();
      const order: string[] = [];
      bus.subscribe(() => {
        throw new Error("boom");
      });
      bus.subscribe(() => order.push("b"));

      expect(() => bus.publish("x")).not.toThrow();
      expect(order).toEqual(["b"]);
    });
  });

  describe("chained bubble (parent -> c1 -> c2)", () => {
    test("a leaf publish fires local subscribers first, then bubbles up in order", () => {
      const parent = new Eventing();
      const c1 = new Eventing();
      const c2 = new Eventing();
      parent.add(c1);
      c1.add(c2);

      const order: string[] = [];
      parent.subscribe(() => order.push("parent"));
      c1.subscribe(() => order.push("c1"));
      c2.subscribe(() => order.push("c2"));

      c2.publish("done", { id: 7 });

      // leaf first, then each ancestor up the chain.
      expect(order).toEqual(["c2", "c1", "parent"]);
    });

    test("the same type and payload arrive at every level", () => {
      const parent = new Eventing();
      const c1 = new Eventing();
      const c2 = new Eventing();
      parent.add(c1);
      c1.add(c2);

      const atParent: EventMessage[] = [];
      const atC1: EventMessage[] = [];
      parent.subscribe((e) => atParent.push(e));
      c1.subscribe((e) => atC1.push(e));

      c2.publish("result", { ok: true });

      expect(atC1).toEqual([{ type: "result", payload: { ok: true } }]);
      expect(atParent).toEqual([{ type: "result", payload: { ok: true } }]);
    });

    test("events only bubble up, never down", () => {
      const parent = new Eventing();
      const c1 = new Eventing();
      const c2 = new Eventing();
      parent.add(c1);
      c1.add(c2);

      const order: string[] = [];
      parent.subscribe(() => order.push("parent"));
      c1.subscribe(() => order.push("c1"));
      c2.subscribe(() => order.push("c2"));

      // Publishing mid-chain reaches c1 and parent, but not the leaf c2.
      c1.publish("mid");

      expect(order).toEqual(["c1", "parent"]);
    });

    test("detaching a link stops the bubble at that seam", () => {
      const parent = new Eventing();
      const c1 = new Eventing();
      const c2 = new Eventing();
      const detachParent = parent.add(c1);
      c1.add(c2);

      const order: string[] = [];
      parent.subscribe(() => order.push("parent"));
      c1.subscribe(() => order.push("c1"));

      detachParent();
      c2.publish("done");

      // c2 -> c1 still works; c1 -> parent is severed.
      expect(order).toEqual(["c1"]);
    });

    test("a fan-in child reaches each parent exactly once (no diamond duplication)", () => {
      // root listens to both a and b; both a and b listen to leaf.
      const root = new Eventing();
      const a = new Eventing();
      const b = new Eventing();
      const leaf = new Eventing();
      root.add(a);
      root.add(b);
      a.add(leaf);
      b.add(leaf);

      let rootHits = 0;
      root.subscribe(() => (rootHits += 1));

      leaf.publish("once");

      expect(rootHits).toBe(1);
    });
  });

  // Locks in the exact production wiring: the REPL subscribes to the runtime bus
  // (the "parent"), and a turn publishes on a child chained under it. A regression
  // here is what makes a produced answer never reach the terminal.
  describe("production wiring (runtime bus <- turn child)", () => {
    test("publishing on the turn child reaches a subscriber on the runtime bus", () => {
      const runtimeBus = new Eventing();   // what the REPL subscribes to
      const turnBus = new Eventing();      // what the orchestrator's turn publishes on
      runtimeBus.add(turnBus);             // parent.add(child) — the only correct direction

      const seen: EventMessage[] = [];
      runtimeBus.subscribe((event) => seen.push(event));

      turnBus.publish("orchestrator-message", { content: "hi" });

      expect(seen).toEqual([{ type: "orchestrator-message", payload: { content: "hi" } }]);
    });

    test("the reversed call (child.add(parent)) does NOT propagate child -> parent", () => {
      // The inversion that silently breaks the cascade: registering the parent as
      // a child of the leaf wires the bubble the wrong way, so a turn publish never
      // reaches the runtime/REPL subscriber.
      const runtimeBus = new Eventing();
      const turnBus = new Eventing();
      turnBus.add(runtimeBus);             // WRONG: now runtimeBus bubbles into turnBus

      const seen: EventMessage[] = [];
      runtimeBus.subscribe((event) => seen.push(event));

      turnBus.publish("orchestrator-message", { content: "hi" });

      expect(seen).toEqual([]);
    });
  });
});
