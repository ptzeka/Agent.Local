import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import type { Eventing } from "@agent-local/common/eventing";
import type { ILogger } from "@agent-local/common/ilogger";
import { buildRuntime } from "../agent/runtime/build-runtime.js";
import type { AgentRuntime } from "../agent/runtime/agent-runtime.js";
import type { AgentRuntimeDeps } from "../agent/runtime/types.js";

// walk up to the workspace root (the dir holding mcp.json) — the same anchor the CLI bootstrap uses
function findProjectRoot(): string {
  let cursor = path.resolve(url.fileURLToPath(new URL(".", import.meta.url)));
  for (;;) {
    if (fs.existsSync(path.join(cursor, "mcp.json"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("agent worker: could not locate mcp.json above the runtime");
    cursor = parent;
  }
}

export interface WorkerRuntimeOptions {
  // host's bus; the runtime chains its own under it, so turn events bubble up to the host (and the console SSE)
  bus: Eventing;
  // host's root signal so a host shutdown cancels the in-flight turn
  signal: AbortSignal;
  logger: ILogger;
  // reuse one session per workflow process instance (the mesh passes pi:<key>)
  sessionId?: string;
}

// builds a headless AgentRuntime for one job. Deps mirror the CLI's bootstrap; paths are env-overridable.
// streamOutput stays off (no TTY) — the worker collects the final answer and reports it as agent.result.
export async function buildWorkerRuntime(opts: WorkerRuntimeOptions): Promise<AgentRuntime> {
  const projectRoot = findProjectRoot();
  const sandboxRoot = path.resolve(
    process.env.AGENT_WORKSPACE ?? path.join(projectRoot, "src", "agent", "workspace"),
  );
  fs.mkdirSync(sandboxRoot, { recursive: true });
  const sessionsDir = path.resolve(
    process.env.AGENT_SESSIONS_DIR ?? path.join(projectRoot, "src", "agent", "sessions"),
  );
  const token = process.env.AGENT_API_TOKEN;

  const deps: AgentRuntimeDeps = {
    configPath: path.join(projectRoot, "models.json"),
    mcpConfigPath: path.join(projectRoot, "mcp.json"),
    sessionsDir,
    workspaceRoot: projectRoot,
    sandboxRoot,
    logger: opts.logger,
    credentials: token ? { token } : {},
    orchestratorRole: "orchestrator",
    parentSignal: opts.signal,
    eventing: opts.bus,
    streamOutput: false,
  };
  return buildRuntime(deps, opts.sessionId).build();
}
