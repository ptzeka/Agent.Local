import { describe, expect, jest, test } from "@jest/globals";

import { InheritedUserMiddleware } from "../../src/agent/runtime/middleware/inherited-user.js";
import type { Principal } from "../../src/agent/identity/types.js";
import { UserToken } from "../../src/agent/runtime/tokens.js";
import { makeContext } from "./context.js";

// a sub-session inherits its parent's resolved identity (principal); this stamps it onto the context for
// ChildSessionMiddleware to pick up
describe("InheritedUserMiddleware", () => {
  test("seeds ctx.user with the provided principal and continues", async () => {
    const principal: Principal = {
      id: "user-1",
      name: "Alice",
      email: "alice@example.com",
    };
    const ctx = makeContext();
    const next = jest.fn(async () => {});

    await new InheritedUserMiddleware(principal).initialize(ctx, next);

    expect(ctx.registry.tryGet(UserToken)).toBe(principal);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("tolerates undefined principal (though parent should always provide one)", async () => {
    const ctx = makeContext();
    const next = jest.fn(async () => {});

    await new InheritedUserMiddleware(undefined).initialize(ctx, next);

    expect(ctx.registry.tryGet(UserToken)).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
