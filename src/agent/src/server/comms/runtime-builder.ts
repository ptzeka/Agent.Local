import fs from "node:fs";
import path from "node:path";
import type { DatabaseHandle } from "@agent-local/common/db";
import { Eventing, type ILogger } from "@agent-local/common";
import { buildRuntime, type AgentRuntime, type AgentRuntimeDeps } from "../../runtime.js";
import { findProjectRoot, moduleDir, resolveSandboxRoot, resolveSessionsDir } from "../../paths.js";
import { loadModelsFile, type RuntimeConfig } from "../../agent/registries/index.js";
import { readMcpServerDefs } from "../../agent/runtime/middleware/external-mcp.js";
import type { AgentServerSettings } from "../appsettings.js";

// builds a session-bound runtime resuming off disk. Shared by the one-shot job runner (build → one turn → drain)
// and the live SSE session (one runtime per connection). models.json + mcp.json are parsed once and reused.
export class RuntimeBuilder {
  private runtimeConfig?: RuntimeConfig;

  // process-level deps every build shares: the root signal each turn cancels on, the one agent.sqlite handle,
  // the agent's own runtime config, and the logger.
  constructor(
    private readonly signal: AbortSignal,
    private readonly db: DatabaseHandle,
    private readonly config: AgentServerSettings,
    private readonly logger: ILogger,
  ) {}

  // streamOutput opts the orchestrator into emitting chat deltas (CHAT_START/MESSAGE_DELTA); it never writes to
  // stdout, so a server runtime sets it to stream chat over SSE. orchestratorRole selects the run profile: the job
  // path passes "workflow-orchestrator" (whitelists turnresult → report_result is mounted → structured verdict
  // envelope required to answer a workflow); the conversational SSE path defaults to "orchestrator". eventing seeds
  // the runtime's bus — pass a fresh one to isolate a connection's events; the job path passes the process bus.
  build(
    sessionId: string,
    options: {
      streamOutput?: boolean;
      orchestratorRole?: AgentRuntimeDeps["orchestratorRole"];
      eventing?: Eventing;
      // the verified caller's bearer (from req.userContext / the queued job): the runtime verifies it again
      // against the authority's JWKS and stamps its subject on the session. Falls back to the service's own
      // env token so headless/staged setups keep working when no caller identity was presented.
      accessToken?: string | null;
    } = {},
  ): Promise<AgentRuntime> {
    const { workspace, sessionsDir: configuredSessionsDir } = this.config;
    const projectRoot = findProjectRoot(moduleDir(import.meta.url));
    const sandboxRoot = resolveSandboxRoot(projectRoot, workspace);
    fs.mkdirSync(sandboxRoot, { recursive: true });
    const sessionsDir = resolveSessionsDir(projectRoot, configuredSessionsDir);
    const token = options.accessToken ?? process.env.AGENT_API_TOKEN;
    this.runtimeConfig ??= {
      models: loadModelsFile(path.join(projectRoot, "models.json")),
      settings: this.config,
      mcpServers: readMcpServerDefs(path.join(projectRoot, "mcp.json")),
    };
    const runtimeDeps: AgentRuntimeDeps = {
      config: this.runtimeConfig,
      sessionsDir,
      db: this.db,
      workspaceRoot: projectRoot,
      sandboxRoot,
      logger: this.logger,
      credentials: token ? { token } : {},
      orchestratorRole: options.orchestratorRole ?? "orchestrator",
      parentSignal: this.signal,
      eventing: options.eventing ?? new Eventing(),
      streamOutput: options.streamOutput ?? false,
    };
    this.logger.debug?.(`[agent-server] building runtime for session ${sessionId}`);
    return buildRuntime(runtimeDeps, sessionId).build();
  }
}
