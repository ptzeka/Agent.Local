import { describe, expect, jest, test } from "@jest/globals";

import { InputInboxMiddleware } from "../../src/agent/runtime/middleware/input-inbox.js";
import { InboxToken } from "../../src/agent/runtime/tokens.js";
import { makeContext } from "./context.js";

/**
 * InputInboxMiddleware business logic: create the external input-injection seam
 * the orchestrator drains each iteration.
 */
describe("InputInboxMiddleware", () => {
  test("seeds ctx.inbox with a working inbox and advances", async () => {
    const ctx = makeContext();
    const next = jest.fn(async () => {});

    await new InputInboxMiddleware().initialize(ctx, next);

    const inbox = ctx.registry.tryGet(InboxToken);
    expect(inbox).toBeDefined();
    expect(next).toHaveBeenCalledTimes(1);

    inbox!.push("s1", "hello");
    expect(inbox!.drain("s1")).toEqual(["hello"]);
  });

  test("the seeded inbox starts empty — draining an unknown session yields nothing", async () => {
    const ctx = makeContext();

    await new InputInboxMiddleware().initialize(ctx, jest.fn(async () => {}));

    const inbox = ctx.registry.get(InboxToken);
    expect(inbox.hasPending("s1")).toBe(false);
    expect(inbox.drain("s1")).toEqual([]);
  });
});
