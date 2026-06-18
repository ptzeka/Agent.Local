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
  secrets?: Record<string, string>;
}

export interface AppSettings {
  agent: AgentClientSettings;
  workflow: WorkflowSettings;
  web: WebSettings;
  host: HostSettings;
}
