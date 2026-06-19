// client-side access to the JWT the login page stashes. This is the BROWSER half of auth: it reads the
// stored token and decodes (NOT verifies) its claims for display only — the agent/host still verify the
// signature server-side. Guarded for SSR: localStorage/atob only exist in the browser, so callers must
// invoke these from effects, never during render.
export const TOKEN_KEY = "agent.local.jwt";

// fired on `window` whenever the stored token changes, so same-tab listeners (the app bar's UserMenu)
// refresh immediately after sign in / sign out. The native `storage` event only fires in OTHER tabs.
export const AUTH_CHANGED_EVENT = "agent.local.auth-changed";

function notifyAuthChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
}

// single writer for the token so the change event can't be forgotten by a caller
export function setStoredToken(token: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(TOKEN_KEY, token);
  notifyAuthChanged();
}

// claims the host signs into the token (see common/jwt.ts) plus standard iat/exp timestamps
export interface TokenClaims {
  sub: string;
  userName: string;
  firstName: string;
  lastName: string;
  permissions: string[];
  iat?: number;
  exp?: number;
}

export function getStoredToken(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function clearStoredToken(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
  notifyAuthChanged();
}

// decode the payload segment for display; returns null on any malformed token. Signature is NOT checked —
// trust comes from server-side verifyIdentity, this only renders what the holder already has.
export function decodeToken(token: string): TokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(b64)
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    );
    const raw = JSON.parse(json) as Record<string, unknown>;
    return {
      sub: String(raw.sub ?? ""),
      userName: String(raw.userName ?? ""),
      firstName: String(raw.firstName ?? ""),
      lastName: String(raw.lastName ?? ""),
      permissions: Array.isArray(raw.permissions) ? (raw.permissions as string[]) : [],
      iat: typeof raw.iat === "number" ? raw.iat : undefined,
      exp: typeof raw.exp === "number" ? raw.exp : undefined,
    };
  } catch {
    return null;
  }
}
