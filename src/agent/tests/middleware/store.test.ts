import { describe, expect, jest, test } from "@jest/globals";

import { StoreMiddleware } from "../../src/agent/runtime/middleware/store.js";
import { StoreToken } from "../../src/agent/runtime/tokens.js";
import { createSession } from "../../src/agent/session/session.js";
import { makeContext } from "./context.js";

// opens a real SessionStore on ctx.db and hands it to the rest of the pipeline
describe("StoreMiddleware", () => {
  test("seeds ctx.store with a store on ctx.db and advances", async () => {
    const ctx = makeContext();
    const next = jest.fn(async () => {});

    await new StoreMiddleware().initialize(ctx, next);

    const store = ctx.registry.tryGet(StoreToken);
    expect(store).toBeDefined();
    expect(next).toHaveBeenCalledTimes(1);

    // Round-trip through the DB proves it's a real, usable store.
    await store!.save(createSession({ sessionId: "s1", workspaceId: "w1", conversationId: "c1" }));
    expect((await store!.getSessionById("s1"))?.sessionId).toBe("s1");
  });

  test("the seeded store is empty — unknown ids load as null, not stale data", async () => {
    const ctx = makeContext();

    await new StoreMiddleware().initialize(ctx, jest.fn(async () => {}));

    expect(await ctx.registry.get(StoreToken).getSessionById("does-not-exist")).toBeNull();
  });
});
