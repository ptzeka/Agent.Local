import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// the agent service owns its own runtime config (no shared/global appsettings); the file sits beside this
// loader under src/server and is read by fs so it stays editable without a rebuild, in both tsx and dist runs.
// host -> agent bearer is a host-issued RS256 JWT: `authorityUrl` is where the agent fetches the signing
// PUBLIC key (and the issuer it expects), so tokens are validated offline against it — no shared secret.
// `tokenEnv` stays as the legacy static-token fallback used when no authorityUrl is set. `required` gates
// enforcement: false keeps the staged stub (accept every caller) until the host sender presents a token.
export interface AgentAuthSettings {
  scheme: "bearer";
  required: boolean;
  tokenEnv: string;
  authorityUrl?: string;
  // client-credentials the agent uses to fetch its own bearer from the host's /api/auth/token (basic -> JWT).
  // LOCAL DEV: the secret is inline here; in prod appsettings is resolved from a secret store, not committed.
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface AgentServerSettings {
  port: number;
  workspace: string;
  sessionsDir: string;
  host: { receiveUrl: string };
  authentication: AgentAuthSettings;
  secrets?: Record<string, string>;
}

function findPackageRoot(): string {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(cursor, "package.json"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("server: could not locate package.json above the appsettings loader");
    cursor = parent;
  }
}

function resolveSettingsPath(): string {
  if (process.env.AGENT_APPSETTINGS_PATH) return path.resolve(process.env.AGENT_APPSETTINGS_PATH);
  return path.join(findPackageRoot(), "src", "server", "appsettings.json");
}

// secrets are NOT read here — appsettings only names env vars; the runtime reads its own from process.env.
export function loadAgentSettings(): AgentServerSettings {
  const raw = fs.readFileSync(resolveSettingsPath(), "utf8");
  return JSON.parse(raw) as AgentServerSettings;
}
