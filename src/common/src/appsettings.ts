// the host-owned application configuration contract. The host is the single owner of hosting, so it
// owns one appsettings.json and slices it to each feature; this type is the shared shape both sides agree on.
// secrets never live here — each `secrets` map only NAMES the env var a value comes from (env is the source).

// host-side client config: the agent now runs as its own service, so the host only needs where to reach it.
// the agent's runtime config (workspace/sessions/models) lives in the agent's own appsettings, not here.
export interface AgentClientSettings {
  baseUrl: string;
}

// where a service's SQLite database lives. SQLite has no network conn string, so this is a file path;
// the *_DB_FILE env var still wins as an ops override. local dev keeps the path inline here; in prod the
// value is resolved from a secret store (named via the feature's `secrets` map), never committed.
export interface DbSettings {
  file: string;
}

export interface WorkflowSettings {
  // engine-neutral task identifier; the Temporal mount maps it to the worker's task queue
  taskType?: string;
  // allowlist of workflow types the host may start; empty/omitted = unrestricted. Enablement is gated here at
  // start so a type can be disabled without removing its worker registration.
  enabledProcessIds?: string[];
  secrets?: Record<string, string>;
}

export interface WebSettings {
  title: string;
  theme: string;
  basePath: string;
  apiAddress: string;
  oauth: { authorityUrl: string; clientId: string };
  secrets?: Record<string, string>;
}

export interface HostSettings {
  port: number;
  // host.sqlite location for the M3-H job repository (HOST_DB_FILE env overrides; see DbSettings)
  db?: DbSettings;
  iam?: { issuerUrl: string; audience: string };
  // symmetric secret the host derives the session-cookie encryption key from (see sessionKey). local-only
  // for now (will move to a secret store); the host both seals and opens the ticket, so it never leaves it.
  session?: { secret: string };
  // the host's OWN service identity for calling the agent: client-credentials it exchanges at its own
  // /connect/token for a short-lived agent:trigger bearer, so dispatch never rides a user's token.
  dispatch?: { tokenUrl: string; clientId: string; clientSecret: string };
  secrets?: Record<string, string>;
}

export interface AppSettings {
  agent: AgentClientSettings;
  workflow: WorkflowSettings;
  web: WebSettings;
  host: HostSettings;
}
