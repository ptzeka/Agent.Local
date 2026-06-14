import { describe, expect, test } from "@jest/globals";

import { Eventing } from "../../src/common/eventing.js";
import { EventingMiddleware } from "../../src/agent/runtime/middleware/eventing.js";
import type { RuntimeContext } from "../../src/agent/runtime/types.js";

// the runtime's bus is created once and must survive a rebuild (reset/compact re-run the pipeline);
// re-minting it would strand a host's one-time subscription on a dead bus — the orphaned-bus regression
describe("EventingMiddleware", () => {
  // minimal context: the middleware only touches `eventing`
  const ctxWith = (eventing?: Eventing): RuntimeContext =>
    ({ eventing } as unknown as RuntimeContext);

  test("mints a bus on a fresh build (no seeded eventing)", async () => {
    const ctx = ctxWith(undefined);
    await new EventingMiddleware().initialize(ctx, async () => {});

    expect(ctx.eventing).toBeInstanceOf(Eventing);
  });

  test("reuses a seeded bus on rebuild rather than replacing it", async () => {
    const existing = new Eventing();
    const ctx = ctxWith(existing);

    await new EventingMiddleware().initialize(ctx, async () => {});

    // Same object: a host subscribed to `existing` still receives after rebuild.
    expect(ctx.eventing).toBe(existing);
  });

  test("chains the bus under the host parent so turn events bubble up", async () => {
    const parent = new Eventing();
    const ctx = ctxWith(undefined);

    await new EventingMiddleware({ parent }).initialize(ctx, async () => {});

    const seen: string[] = [];
    parent.subscribe((event) => seen.push(event.type));
    ctx.eventing!.publish("orchestrator-message");

    expect(seen).toEqual(["orchestrator-message"]);
  });

  test("re-chaining the same bus on rebuild does not duplicate delivery", async () => {
    const parent = new Eventing();
    const existing = new Eventing();
    const ctx = ctxWith(existing);

    // Two builds with the same seeded bus and parent — add() must dedupe.
    await new EventingMiddleware({ parent }).initialize(ctx, async () => {});
    await new EventingMiddleware({ parent }).initialize(ctx, async () => {});

    let hits = 0;
    parent.subscribe(() => (hits += 1));
    existing.publish("once");

    expect(hits).toBe(1);
  });
});
