/**
 * Identity types.
 *
 * Intentionally OIDC-aligned (sub / iss / claims / scopes) rather than the
 * .NET ClaimsPrincipal hierarchy — the agent runtime is not an HTTP server and
 * doesn't need the extra abstraction layers.
 *
 * A session always carries a Principal. When no credentials are presented the
 * principal is the ANONYMOUS_PRINCIPAL (isAuthenticated = false). Callers
 * never null-check — they check the flag.
 */

export interface Principal {
  /** Subject identifier — the canonical "who" (OIDC `sub` claim). */
  sub: string;
  /** Issuer that granted this identity, if known. */
  iss?: string;
  /** True only when a handler successfully validated real credentials. */
  isAuthenticated: boolean;
  /** Raw claim bag — standard OIDC names (`name`, `email`, `roles`, …). */
  claims: Record<string, string | string[]>;
  /** Capability grants, e.g. `["read:workspace", "execute:tools"]`. */
  scopes: string[];
}

/**
 * Tri-state result produced by an IAuthenticationHandler:
 *   authenticated — handler validated credentials and built a principal
 *   failed        — credentials were presented but rejected (e.g. expired JWT)
 *   none          — no credentials present; pipeline may try the next handler
 */
export type AuthenticateResult =
  | { state: "authenticated"; principal: Principal }
  | { state: "failed"; reason: string }
  | { state: "none" };

/** Credentials forwarded into the identity pipeline. */
export interface IdentityContext {
  /** Bearer token, API key, or any opaque credential string. */
  token?: string;
}

/**
 * Sentinel returned when no handler authenticates the caller. The session
 * still gets a valid Principal — downstream code only checks `isAuthenticated`.
 */
export const ANONYMOUS_PRINCIPAL: Principal = {
  sub: "anonymous",
  isAuthenticated: false,
  claims: {},
  scopes: [],
};
