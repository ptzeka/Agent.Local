import type { Principal } from "../../identity/types.js";
import { UserToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

// resolves a Principal from ctx credentials, leaving the user unset on failure so AnonymousMiddleware takes over
// MOCK: decodes the JWT payload without verifying the signature — swap resolve() for a real authority call in prod
export class IdentityMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    const principal = this.resolve(ctx.credentials.token);
    if (principal) {
      ctx.registry.set(UserToken, principal);
    }
    await next();
  }

  // MOCK: base64url-decodes the payload with no signature check; null when token is absent, malformed, or non-JSON
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
