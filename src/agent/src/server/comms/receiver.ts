import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import type { DatabaseHandle } from "@agent-local/common/db";
import { Eventing, type ILogger, type IReceiver, type EventEnvelope } from "@agent-local/common";
import { LOGGER, SERVER_CONFIG } from "../container-tokens.js";
import { buildRuntime, type AgentRuntime, type AgentRuntimeDeps } from "../../runtime.js";
import { findProjectRoot, moduleDir, resolveSandboxRoot, resolveSessionsDir } from "../../paths.js";
import type { AgentServerSettings } from "../appsettings.js";
import { SESSION_HEADER } from "../middleware/session-header.js";
import { WORKFLOW_JOB, AGENT_RESULT, WORKFLOW_FAILED, type WorkflowJob } from "./contract.js";

// the request-scoped inputs receive() needs beyond the envelope: the upstream context middleware resolved them
// onto req, the express adapter lifts them out so receive() itself stays transport-free (callable from a test).
export interface AgentReceiveContext {
  config: AgentServerSettings;
  logger: ILogger;
  eventing: Eventing;
  sessionId: string;
}

// the workflow job carries the instruction in a variable; accept the common spellings
function promptFor(variables: Record<string, unknown>): string {
  return String(variables.prompt ?? variables.input ?? variables.task ?? "").trim();
}

// host -> agent RECEIVER: the host's sender posts finished-job requests here. receive() owns the whole turn
// lifecycle — build a fresh runtime bound to the request's session, run ONE turn, publish the answer on the
// request bus (the result sender webhooks it to the host), then drain the runtime, which lives only for the job.
// routes() is the express adapter; the answer returns out-of-band, so it ACKs 202 rather than blocking.
export class HttpJobReceiver implements IReceiver<AgentReceiveContext> {
  // process-level deps every request shares: the root signal each turn cancels on, and the one agent.sqlite handle
  constructor(
    private readonly signal: AbortSignal,
    private readonly db: DatabaseHandle,
  ) {}

  async receive(envelope: EventEnvelope, ctx: AgentReceiveContext): Promise<void> {
    // the route already 400s a malformed envelope; this guards a direct call so receive() is self-contained
    if (envelope.eventType !== WORKFLOW_JOB) return;
    const job = envelope.payload as WorkflowJob;
    const prompt = promptFor(job.variables ?? {});
    if (!prompt) {
      // a turn-level failure surfaces as workflow.failed so the workflow can fail the step, not a transport error
      ctx.eventing.publish(WORKFLOW_FAILED, {
        temporalId: job.temporalId,
        jobKey: job.jobKey,
        error: "agent job carried no prompt/input/task variable",
      });
      return;
    }
    const runtime = await this.buildForJob(ctx);
    try {
      const result = await runtime.dispatchAsync(prompt, { signal: this.signal });
      const text = result.finalMessage.content;
      // the turn's own success/failure verdict (satisfied | awaiting-input | capped | failed), carried alongside
      // the text so the WORKFLOW fails a step on a non-satisfied turn instead of sniffing the message for a prefix.
      ctx.eventing.publish(AGENT_RESULT, {
        temporalId: job.temporalId,
        jobKey: job.jobKey,
        result: text,
        outcome: result.outcome,
        // returned DOWN to the workflow by the engine when it completes the job
        variables: { agentResult: text, temporalId: job.temporalId },
      });
    } finally {
      // the runtime lives only for this job: drain so the session flushes to disk and MCP clients close
      await runtime
        .shutdown({ mode: "drain", timeoutMs: 30_000 })
        .catch((err) => ctx.logger.error?.("[agent-server] runtime close failed", err));
    }
  }

  // builds the per-request runtime bound to its session, resuming off disk. Paths are env-overridable;
  // streamOutput stays off (no TTY) — receive() collects the final answer and reports it as agent.result.
  private buildForJob(ctx: AgentReceiveContext): Promise<AgentRuntime> {
    const { workspace, sessionsDir: configuredSessionsDir } = ctx.config;
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
      logger: ctx.logger,
      credentials: token ? { token } : {},
      orchestratorRole: "orchestrator",
      parentSignal: this.signal,
      eventing: ctx.eventing,
      streamOutput: false,
    };
    ctx.logger.debug?.(`[agent-server] building runtime for session ${ctx.sessionId}`);
    return buildRuntime(runtimeDeps, ctx.sessionId).build();
  }

  // express adapter: the runtime inputs are resolved onto req by the upstream context middleware; lift them into
  // a ctx, hand the envelope to receive(), and ACK 202 — the answer returns out-of-band via the result sender.
  routes(): Router {
    const router = Router();
    router.post("/events", (req: Request, res: Response) => {
      const envelope = req.body as EventEnvelope;
      if (envelope?.eventType !== WORKFLOW_JOB) {
        res.status(400).json({ error: `unsupported eventType ${String(envelope?.eventType)}` });
        return;
      }
      const logger = req.container.get(LOGGER);
      const ctx: AgentReceiveContext = {
        config: req.container.get(SERVER_CONFIG),
        logger,
        eventing: req.container.get(Eventing),
        sessionId: req.header(SESSION_HEADER)?.trim() || "anonymous",
      };
      void this.receive(envelope, ctx).catch((err) => logger.error?.("[agent-server] run failed", err));
      res.status(202).json({ accepted: true });
    });
    return router;
  }
}
