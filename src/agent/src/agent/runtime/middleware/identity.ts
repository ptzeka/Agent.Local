import type { Principal } from "../../identity/types.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

/**
 * IdentityMiddleware — reads credentials from ctx and attempts to resolve a
 * Principal. Sets ctx.user when successful; leaves it undefined otherwise so
 * AnonymousMiddleware (or any downstream fallback) can take over.
 *
 * This implementation is a MOCK: it decodes the JWT payload without verifying
 * the signature. Replace the `resolve` method body with a real authority call
 * (e.g. JWKS fetch + signature verification) when real auth is needed.
 */
export class IdentityMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    const principal = this.resolve(ctx.credentials.token);
    if (principal) {
      ctx.user = principal;
    }
    await next();
  }

  /**
   * Attempt to decode a JWT and produce a Principal.
   *
   * Mock behaviour: base64url-decodes the payload segment without any
   * signature check. Extracts standard OIDC claims (`sub`, `iss`, `name`,
   * `email`, `roles`, `scope`). Returns null when the token is absent, not
   * three-part, or the payload is not valid JSON.
   *
   * Replace this with signature verification + authority validation in prod.
   */
  private resolve(token: string | undefined): Principal | null {
    if (!token) return null;

    const parts = token.split(".");
    if (parts.length !== 3) return null;

    let payload: Record<string, unknown>;
    try {
      const json = Buffer.from(parts[1], "base64url").toString("utf8");
      payload = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return null;
    }

    const sub = typeof payload.sub === "string" ? payload.sub : null;
    if (!sub) return null;

    const roles = Array.isArray(payload.roles)
      ? (payload.roles as unknown[]).filter((r): r is string => typeof r === "string")
      : typeof payload.role === "string"
      ? [payload.role]
      : [];

    const scopes =
      typeof payload.scope === "string"
        ? payload.scope.split(" ").filter(Boolean)
        : [];

    const claims: Record<string, string | string[]> = { sub };
    if (typeof payload.iss === "string") claims.iss = payload.iss;
    if (typeof payload.name === "string") claims.name = payload.name;
    if (typeof payload.email === "string") claims.email = payload.email;
    if (roles.length > 0) claims.roles = roles;

    return {
      sub,
      iss: typeof payload.iss === "string" ? payload.iss : undefined,
      isAuthenticated: true,
      claims,
      scopes,
    };
  }
}
