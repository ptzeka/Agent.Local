// OIDC-aligned (sub/iss/claims/scopes) on purpose: the runtime is not an HTTP server,
// so it skips the .NET ClaimsPrincipal hierarchy; callers check isAuthenticated, never null
export interface Principal {
  sub: string;
  iss?: string;
  // true only when a handler validated real credentials
  isAuthenticated: boolean;
  claims: Record<string, string | string[]>;
  // capability grants, e.g. ["read:workspace", "execute:tools"]
  scopes: string[];
}

// tri-state so the pipeline can distinguish "rejected" from "absent" and try the next handler
export type AuthenticateResult =
  | { state: "authenticated"; principal: Principal }
  | { state: "failed"; reason: string }
  | { state: "none" };

export interface IdentityContext {
  token?: string;
  userId?: string;
}

// every session carries a Principal so downstream code checks isAuthenticated instead of null
export const ANONYMOUS_PRINCIPAL: Principal = {
  sub: "anonymous",
  isAuthenticated: false,
  claims: {},
  scopes: [],
};
