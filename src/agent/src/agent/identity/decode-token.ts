import type { Principal } from "./types.js";

// claims mapping ONLY — base64url-decodes the JWT payload with no signature check. Cryptographic verification
// lives in IdentityMiddleware (JWKS gate before this mapping runs); the CLI also calls this bare, but purely for
// display (picker header/scoping) — the runtime it then builds re-verifies the same token before trusting it.
export function decodePrincipal(token: string | undefined): Principal | null {
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
  // the auth service's own tokens (see src/auth/src/auth-api.ts) carry userName, not the generic `name` claim
  if (typeof payload.userName === "string") claims.userName = payload.userName;
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
