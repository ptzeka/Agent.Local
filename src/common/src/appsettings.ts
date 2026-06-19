// the host-owned application configuration contract. The host is the single owner of hosting, so it
// owns one appsettings.json and slices it to each feature; this type is the shared shape both sides agree on.
// secrets never live here — each `secrets` map only NAMES the env var a value comes from (env is the source).

// host-side client config: the agent now runs as its own service, so the host only needs where to reach it.
// the agent's runtime config (workspace/sessions/models) lives in the agent's own appsettings, not here.
export interface AgentClientSettings {
  baseUrl: string;
}

export interface WorkflowSettings {
  taskType?: string;
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
  iam?: { issuerUrl: string; audience: string };
  // symmetric secret the host derives the session-cookie encryption key from (see sessionKey). local-only
  // for now (will move to a secret store); the host both seals and opens the ticket, so it never leaves it.
  session?: { secret: string };
  // the host's OWN service identity for calling the agent: client-credentials it exchanges at its own
  // /api/auth/token for a short-lived agent:trigger bearer, so dispatch never rides a user's token.
  dispatch?: { tokenUrl: string; clientId: string; clientSecret: string };
  secrets?: Record<string, string>;
}

export interface AppSettings {
  agent: AgentClientSettings;
  workflow: WorkflowSettings;
  web: WebSettings;
  host: HostSettings;
}
