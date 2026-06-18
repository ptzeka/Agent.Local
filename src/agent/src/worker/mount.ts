import type { Eventing, ILogger, AppSettings } from "@agent-local/common";
import {
  AGENT_RESULT,
  WORKFLOW_JOB,
  WORKFLOW_COMPLETED,
  WORKFLOW_FAILED,
  type WorkflowJob,
  type WorkflowCompleted,
  type WorkflowFailed,
} from "./contract.js";
import type { AgentRuntime } from "../agent/runtime/agent-runtime.js";
import { buildWorkerRuntime } from "./runtime.js";

export interface MountContext {
  bus: Eventing;
  logger: ILogger;
  signal: AbortSignal;
  // the host passes the whole appsettings; the worker reads only its `agent` section (workspace/sessions)
  settings?: AppSettings;
}

// the camunda job carries the agent's instruction in a variable; accept the common spellings
function promptFor(job: WorkflowJob): string {
  const v = job.variables ?? {};
  return String(v.prompt ?? v.input ?? v.task ?? "").trim();
}

// agent worker — bus-only. The first arg (the host's express app) is intentionally unused and untyped:
// the agent never serves HTTP, but keeping the uniform Mount(app, ctx) shape lets the host wire it
// exactly like web/workflow. It listens for WORKFLOW_JOB directly off the bus, runs one runtime turn,
// and reports the outcome as AGENT_RESULT (or WORKFLOW_FAILED).
export const mount = (_app: unknown, ctx: MountContext): void => {
  const { bus, logger, signal, settings } = ctx;

  // one Camunda process instance == one agent session for its whole lifetime. The live runtime is held
  // here keyed by processInstanceKey so successive jobs of the same instance share conversation context;
  // it is finalized and closed when the instance ends (workflow.completed / instance-level failed).
  const runtimes = new Map<string, AgentRuntime>();

  // open the instance's session on its first job, reuse it thereafter
  async function runtimeFor(job: WorkflowJob): Promise<AgentRuntime> {
    let runtime = runtimes.get(job.processInstanceKey);
    if (!runtime) {
      runtime = await buildWorkerRuntime({
        bus,
        signal,
        logger,
        workspace: settings?.agent?.workspace,
        sessionsDir: settings?.agent?.sessionsDir,
      });
      runtimes.set(job.processInstanceKey, runtime);
      logger.debug?.(
        `[agent-worker] opened session ${runtime.getSession().sessionId} for instance ${job.processInstanceKey}`,
      );
    }
    return runtime;
  }

  // finalize + close the instance's session when camunda is done with it: shutdown(drain) flushes the
  // conversation and saves the session (audit), then releases the runtime's resources (MCP clients, scope).
  async function finalizeInstance(processInstanceKey: string, reason: string): Promise<void> {
    const runtime = runtimes.get(processInstanceKey);
    if (!runtime) return;
    runtimes.delete(processInstanceKey);
    logger.debug?.(`[agent-worker] closing session for instance ${processInstanceKey} (${reason})`);
    try {
      await runtime.shutdown({ mode: "drain", timeoutMs: 30_000 });
    } catch (err) {
      logger.error?.("[agent-worker] finalize failed", err);
    }
  }

  async function runJob(job: WorkflowJob): Promise<void> {
    const prompt = promptFor(job);
    if (!prompt) {
      bus.publish(WORKFLOW_FAILED, {
        processInstanceKey: job.processInstanceKey,
        jobKey: job.jobKey,
        error: "agent job carried no prompt/input/task variable",
      });
      return;
    }
    const runtime = await runtimeFor(job);
    logger.debug?.(`[agent-worker] running job ${job.jobKey} (session ${runtime.getSession().sessionId})`);
    // no per-job shutdown: the runtime lives for the instance lifetime, closed in finalizeInstance
    const result = await runtime.dispatchAsync(prompt, { signal });
    const text = result.finalMessage.content;
    bus.publish(AGENT_RESULT, {
      processInstanceKey: job.processInstanceKey,
      jobKey: job.jobKey,
      sessionId: runtime.getSession().sessionId,
      result: text,
      // returned DOWN to camunda by workflow.completeJob(jobKey, variables)
      variables: { agentResult: text, sessionId: runtime.getSession().sessionId, processInstanceKey: job.processInstanceKey },
    });
  }

  // listen to workflow.job directly off the shared bus and correlate by processInstanceKey (the runtime
  // owns the session id); no separate mesh router re-publishes the job — the worker IS the bridge
  bus.subscribe(WORKFLOW_JOB, (event) => {
    const job = event.payload as unknown as WorkflowJob;
    // fire-and-forget so the bus subscriber returns immediately; failures bubble back as workflow.failed
    void runJob(job).catch((err) => {
      logger.error?.("[agent-worker] job failed", err);
      bus.publish(WORKFLOW_FAILED, {
        processInstanceKey: job.processInstanceKey,
        jobKey: job.jobKey,
        error: String(err),
      });
    });
  });

  // close the session at the end of the instance lifetime. Mirror the mesh: a completed instance always
  // closes; a failed event closes only when it's instance-level (no jobKey) — a single failed job may retry.
  bus.subscribe(WORKFLOW_COMPLETED, (event) => {
    const done = event.payload as unknown as WorkflowCompleted;
    void finalizeInstance(done.processInstanceKey, "completed");
  });
  bus.subscribe(WORKFLOW_FAILED, (event) => {
    const failed = event.payload as unknown as WorkflowFailed;
    if (!failed.jobKey) void finalizeInstance(failed.processInstanceKey, "failed");
  });

  // host shutdown: drain and close every still-open instance session
  signal.addEventListener("abort", () => {
    logger.debug?.("[agent-worker] aborting; closing open sessions");
    for (const key of [...runtimes.keys()]) void finalizeInstance(key, "host-abort");
  });
  logger.debug?.("@agent-local/agent worker mounted (agent.job -> agent.result)");
};
