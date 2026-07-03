import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// the auth service owns its own runtime config (a separate process, like the agent service); the file sits
// beside this loader under src and is read by fs so it stays editable without a rebuild, in tsx and dist runs.
// issuerUrl is the public origin this IdP stamps as `iss` and serves discovery from — every consumer (host,
// agent, dispatch) must point at the SAME value. session.secret derives the cookie key, shared with the host
// so the host can OPEN the ticket this service seals at login.
export interface AuthSettings {
  port: number;
  iam: { issuerUrl: string; audience: string };
  // secret derives the cookie key (shared with the host). cookieDomain widens the cookie to a parent domain
  // (e.g. ".peritze.com") so the host reads it cross-subdomain; omit it for host-only same-origin local dev.
  session: { secret: string; cookieDomain?: string };
  // browser origins allowed to call the account routes with credentials (the web app's origin). The IdP is
  // cross-origin from the web, so a credentialed fetch needs an explicit allow-list — never a wildcard with creds.
  cors?: { allowedOrigins: string[] };
  // public (secret-less) clients allowed through /connect/authorize's PKCE code flow, keyed by client_id. Each
  // entry pins the exact callback path a redirect_uri must match; the port is left free since a loopback CLI
  // client mints a fresh ephemeral one per login. Never widen this to a full-URL allow-list — see auth-api.ts.
  nativeClients?: Record<string, { redirectPath: string }>;
  secrets?: Record<string, string>;
}

function findPackageRoot(): string {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(cursor, "package.json"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("auth: could not locate package.json above the appsettings loader");
    cursor = parent;
  }
}

function resolveSettingsPath(): string {
  if (process.env.AUTH_APPSETTINGS_PATH) return path.resolve(process.env.AUTH_APPSETTINGS_PATH);
  return path.join(findPackageRoot(), "src", "appsettings.json");
}

// secrets are NOT read here — appsettings only names env vars; the service reads its own from process.env.
export function loadAuthSettings(): AuthSettings {
  const raw = fs.readFileSync(resolveSettingsPath(), "utf8");
  return JSON.parse(raw) as AuthSettings;
}
