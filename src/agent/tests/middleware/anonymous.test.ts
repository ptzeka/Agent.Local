import { describe, expect, jest, test } from "@jest/globals";

import type { Principal } from "../../src/agent/identity/types.js";
import { AnonymousMiddleware } from "../../src/agent/runtime/middleware/anonymous.js";
import { UserToken } from "../../src/agent/runtime/tokens.js";
import { makeContext } from "./context.js";

// guarantees ctx.user is set after the identity phase, falling back to the anonymous principal only when no
// earlier step resolved a real one
describe("AnonymousMiddleware", () => {
  test("stamps the anonymous principal when no user was resolved", async () => {
    const ctx = makeContext(); // user undefined
    const next = jest.fn(async () => {});

    await new AnonymousMiddleware().initialize(ctx, next);

    expect(ctx.registry.tryGet(UserToken)?.sub).toBe("anonymous");
    expect(ctx.registry.tryGet(UserToken)?.isAuthenticated).toBe(false);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("does not overwrite an already-resolved user", async () => {
    const resolved: Principal = {
      sub: "user-7",
      isAuthenticated: true,
      claims: { sub: "user-7" },
      scopes: [],
    };
    const ctx = makeContext({ user: resolved });

    await new AnonymousMiddleware().initialize(ctx, jest.fn(async () => {}));

    expect(ctx.registry.tryGet(UserToken)).toBe(resolved);
  });
});
