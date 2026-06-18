import type { Eventing, ILogger } from "@agent-local/common";
import type { AgentRuntime } from "../runtime.js";
import { buildWorkerRuntime } from "./runtime.js";
import { AGENT_RESULT, WORKFLOW_FAILED, type WorkflowJob } from "./contract.js";

// the camunda job carries the instruction in a variable; accept the common spellings (moved from worker/mount)
function promptFor(variables: Record<string, unknown>): string {
  return String(variables.prompt ?? variables.input ?? variables.task ?? "").trim();
}

// owns the per-session runtimes for this agent service. One runtime == one session for its lifetime; the
// host correlates camunda jobs to these sessionIds. Mirrors the retired worker's runtimes Map + finalize.
export class SessionManager {
  private readonly sessions = new Map<string, AgentRuntime>();

  constructor(
    private readonly bus: Eventing,
    private readonly signal: AbortSignal,
    private readonly logger: ILogger,
    private readonly workspace: string,
    private readonly sessionsDir: string,
  ) {}

  // builds a fresh runtime and returns the session id the runtime minted, for the host to correlate
  async create(): Promise<string> {
    const runtime = await buildWorkerRuntime({
      bus: this.bus,
      signal: this.signal,
      logger: this.logger,
      workspace: this.workspace,
      sessionsDir: this.sessionsDir,
    });
    const sessionId = runtime.getSession().sessionId;
    this.sessions.set(sessionId, runtime);
    this.logger.debug?.(`[agent-server] created session ${sessionId}`);
    return sessionId;
  }

  // runs one job for an existing session and publishes the answer as AGENT_RESULT on the internal bus,
  // where the sender forwards it to the host. A turn-level failure surfaces as WORKFLOW_FAILED instead.
  async run(job: WorkflowJob & { sessionId: string }): Promise<void> {
    const runtime = this.sessions.get(job.sessionId);
    if (!runtime) {
      this.bus.publish(WORKFLOW_FAILED, {
        processInstanceKey: job.processInstanceKey,
        jobKey: job.jobKey,
        error: `unknown sessionId ${job.sessionId}`,
      });
      return;
    }
    const prompt = promptFor(job.variables ?? {});
    if (!prompt) {
      this.bus.publish(WORKFLOW_FAILED, {
        processInstanceKey: job.processInstanceKey,
        jobKey: job.jobKey,
        error: "agent job carried no prompt/input/task variable",
      });
      return;
    }
    const result = await runtime.dispatchAsync(prompt, { signal: this.signal });
    const text = result.finalMessage.content;
    this.bus.publish(AGENT_RESULT, {
      processInstanceKey: job.processInstanceKey,
      jobKey: job.jobKey,
      sessionId: job.sessionId,
      result: text,
      // returned DOWN to camunda by workflow.completeJob(jobKey, variables)
      variables: { agentResult: text, sessionId: job.sessionId, processInstanceKey: job.processInstanceKey },
    });
  }

  // drain + close one session: flushes the conversation (audit) then releases the runtime's resources
  async close(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return;
    this.sessions.delete(sessionId);
    try {
      await runtime.shutdown({ mode: "drain", timeoutMs: 30_000 });
    } catch (err) {
      this.logger.error?.("[agent-server] close failed", err);
    }
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.close(id);
  }
}
