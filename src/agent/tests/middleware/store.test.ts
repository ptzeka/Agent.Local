import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StoreMiddleware } from "../../src/agent/runtime/middleware/store.js";
import { createSession } from "../../src/agent/session.js";
import { makeContext } from "./context.js";

/**
 * StoreMiddleware business logic: open a real SessionStore rooted at
 * ctx.sessionsDir and hand it to the rest of the pipeline.
 */
describe("StoreMiddleware", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "store-mw-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("seeds ctx.store with a store rooted at ctx.sessionsDir and advances", async () => {
    const ctx = makeContext({ sessionsDir: path.join(dir, "sessions") });
    const next = jest.fn(async () => {});

    await new StoreMiddleware().initialize(ctx, next);

    expect(ctx.store).toBeDefined();
    expect(next).toHaveBeenCalledTimes(1);

    // Round-trip through the configured directory proves it's a real, usable store.
    await ctx.store!.save(createSession({ sessionId: "s1", workspaceId: "w1" }));
    expect((await ctx.store!.load("s1"))?.sessionId).toBe("s1");
  });

  test("the seeded store is empty — unknown ids load as null, not stale data", async () => {
    const ctx = makeContext({ sessionsDir: path.join(dir, "sessions") });

    await new StoreMiddleware().initialize(ctx, jest.fn(async () => {}));

    expect(await ctx.store!.load("does-not-exist")).toBeNull();
  });
});
