// the host-owned application configuration contract. The host is the single owner of hosting, so it
// owns one appsettings.json and slices it to each feature; this type is the shared shape both sides agree on.
// secrets never live here — each `secrets` map only NAMES the env var a value comes from (env is the source).

export interface AgentSettings {
  workspace: string;
  sessionsDir: string;
  secrets?: Record<string, string>;
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
  agent: AgentSettings;
  workflow: WorkflowSettings;
  web: WebSettings;
  host: HostSettings;
}
