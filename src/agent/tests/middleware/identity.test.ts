import { describe, expect, jest, test } from "@jest/globals";

import { IdentityMiddleware } from "../../src/agent/runtime/middleware/identity.js";
import { makeContext } from "./context.js";

/** Build a (mock, unsigned) JWT with the given payload as the middle segment. */
function jwt(payload: Record<string, unknown>): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "none" })}.${seg(payload)}.signature`;
}

/**
 * IdentityMiddleware business logic: decode a bearer token into a Principal and
 * stamp ctx.user — or leave ctx.user untouched so a fallback can take over.
 */
describe("IdentityMiddleware", () => {
  test("decodes a valid token into an authenticated Principal with claims and scopes", async () => {
    const ctx = makeContext({
      credentials: {
        token: jwt({ sub: "user-42", roles: ["admin"], scope: "read write" }),
      },
    });
    const next = jest.fn(async () => {});

    await new IdentityMiddleware().initialize(ctx, next);

    expect(ctx.user?.sub).toBe("user-42");
    expect(ctx.user?.isAuthenticated).toBe(true);
    expect(ctx.user?.scopes).toEqual(["read", "write"]);
    expect(ctx.user?.claims.roles).toEqual(["admin"]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("resolves a minimal token carrying only sub", async () => {
    const ctx = makeContext({ credentials: { token: jwt({ sub: "bare" }) } });

    await new IdentityMiddleware().initialize(ctx, jest.fn(async () => {}));

    expect(ctx.user?.sub).toBe("bare");
    expect(ctx.user?.scopes).toEqual([]);
  });

  test("leaves ctx.user undefined for a malformed token, still advancing", async () => {
    const ctx = makeContext({ credentials: { token: "not-a-jwt" } });
    const next = jest.fn(async () => {});

    await new IdentityMiddleware().initialize(ctx, next);

    expect(ctx.user).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
