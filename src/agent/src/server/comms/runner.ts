import fs from "node:fs";
import path from "node:path";
import type { DatabaseHandle } from "@agent-local/common/db";
import { Eventing, type ILogger } from "@agent-local/common";
import { buildRuntime, type AgentRuntime, type AgentRuntimeDeps } from "../../runtime.js";
import { findProjectRoot, moduleDir, resolveSandboxRoot, resolveSessionsDir } from "../../paths.js";
import type { AgentServerSettings } from "../appsettings.js";
import {
  EXECUTION_REQUESTED,
  EXECUTION_RESULT,
  type ExecutionRequested,
  type ExecutionResult,
} from "./contract.js";

// the execution worker, off the transport. It subscribes to the receiver's internal event, owns the whole turn
// lifecycle — build a fresh runtime bound to the request's session, run ONE turn, publish the result for the
// sender — then drains the runtime, which lives only for the job. Construction lives HERE, not in the HTTP class.
export class ExecutionRunner {
  // process-level deps every run shares: the root signal each turn cancels on, the one agent.sqlite handle,
  // the agent's own runtime config, and the process bus the receiver/sender also speak.
  constructor(
    private readonly signal: AbortSignal,
    private readonly db: DatabaseHandle,
    private readonly config: AgentServerSettings,
    private readonly logger: ILogger,
    private readonly bus: Eventing,
  ) {}

  // bus binding: every queued request runs one turn and publishes its result back onto the bus
  start(): void {
    this.bus.subscribe(EXECUTION_REQUESTED, (event) => {
      void this.run(event.payload as unknown as ExecutionRequested).catch((err) =>
        this.logger.error?.("[agent-server] run failed", err),
      );
    });
  }

  private async run(requested: ExecutionRequested): Promise<void> {
    const runtime = await this.buildForJob(requested.sessionId);
    try {
      const result = await runtime.dispatchAsync(requested.input, { signal: this.signal });
      const answer: ExecutionResult = {
        sessionId: requested.sessionId,
        runId: requested.runId,
        source: requested.source,
        createdAt: requested.createdAt,
        result: result.finalMessage.content,
        outcome: result.outcome,
      };
      this.bus.publish(EXECUTION_RESULT, { ...answer });
    } finally {
      // the runtime lives only for this job: drain so the session flushes to disk and MCP clients close
      await runtime
        .shutdown({ mode: "drain", timeoutMs: 30_000 })
        .catch((err) => this.logger.error?.("[agent-server] runtime close failed", err));
    }
  }

  // builds the per-job runtime bound to its session, resuming off disk. Paths are env-overridable; streamOutput
  // stays off (no TTY) — the run collects the final answer and reports it as an ExecutionResult.
  private buildForJob(sessionId: string): Promise<AgentRuntime> {
    const { workspace, sessionsDir: configuredSessionsDir } = this.config;
    const projectRoot = findProjectRoot(moduleDir(import.meta.url));
    const sandboxRoot = resolveSandboxRoot(projectRoot, workspace);
    fs.mkdirSync(sandboxRoot, { recursive: true });
    const sessionsDir = resolveSessionsDir(projectRoot, configuredSessionsDir);
    const token = process.env.AGENT_API_TOKEN;
    const runtimeDeps: AgentRuntimeDeps = {
      configPath: path.join(projectRoot, "models.json"),
      mcpConfigPath: path.join(projectRoot, "mcp.json"),
      sessionsDir,
      db: this.db,
      workspaceRoot: projectRoot,
      sandboxRoot,
      logger: this.logger,
      credentials: token ? { token } : {},
      orchestratorRole: "orchestrator",
      parentSignal: this.signal,
      eventing: this.bus,
      streamOutput: false,
    };
    this.logger.debug?.(`[agent-server] building runtime for session ${sessionId}`);
    return buildRuntime(runtimeDeps, sessionId).build();
  }
}
