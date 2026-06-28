import type { Eventing } from "@agent-local/common";
import type { ILogger } from "@agent-local/common/ilogger";
import type { TemporalConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecutionStatus = "running" | "completed" | "failed" | "canceled" | "terminated" | "timedOut";

// `canceled` is folded apart from `failed` so a user stop never overwrites the host's `stopped` with `stuck`
export type TerminalOutcome =
  | { outcome: "completed"; result: unknown }
  | { outcome: "canceled" }
  | { outcome: "failed"; error: string };

// local shape over @temporalio/client so tests inject a fake and the real SDK adapter lands later (M7-9)
export interface TemporalCore {
  connect(): Promise<void>;
  start(req: { workflowType: string; workflowId: string; args: Record<string, unknown> }): Promise<{ runId: string }>;
  describe(workflowId: string): Promise<{ runId: string; workflowType: string; status: ExecutionStatus } | undefined>;
  cancel(workflowId: string): Promise<void>;
  terminate(workflowId: string, reason: string): Promise<void>;
  // re-runs from the last workflow-task boundary with the same inputs; refused on a still-running execution
  reset(workflowId: string, reason: string): Promise<{ runId: string }>;
  // resets to before a chosen step so it (and everything after) re-runs; post-reset signals are dropped so the
  // rerun re-dispatches fresh rather than replaying old answers
  resetToStep(workflowId: string, stepId: string, reason: string): Promise<{ runId: string }>;
  result(workflowId: string): Promise<TerminalOutcome>;
  signal(req: { workflowId: string; name: string; payload: Record<string, unknown> }): Promise<void>;
  query<T>(req: { workflowId: string; name: string; args?: unknown }): Promise<T>;
  history(workflowId: string): Promise<HistoryEvent[]>;
  close(): Promise<void>;
}

// a start refused by the enablement allowlist, not by the server; lets callers map it to 403 not 503
export class WorkflowDisabledError extends Error {
  constructor(public readonly workflowType: string) {
    super(`workflow '${workflowType}' is not enabled`);
    this.name = "WorkflowDisabledError";
  }
}

export interface ExecutionRecord {
  workflowId: string;
  runId: string;
  workflowType: string;
  status: ExecutionStatus;
  startedAt: number;
}

// engine-neutral history event so the client folds steps without importing the SDK's protobuf event shapes
export interface HistoryEvent {
  eventId: string;
  type: string;
  timestamp: string;
  scheduledEventId?: string;
  activityType?: string;
  detail?: string;
  // decoded intent (the dispatched prompt) — distinguishes steps that otherwise all read as the bare activity type
  summary?: string;
  signalName?: string;
  // on an `agentResult` signal: the envelope verdict; getSteps uses it to fail the paired dispatch step, since the
  // fire-and-forget activity's own `completed` only proves the job was published, not that the agent succeeded
  verdict?: string;
  // on an `agentResult` signal: the agent's final structured answer (report_result payload), stringified
  response?: string;
}

// the engine's per-step status, NOT the host work-status catalog (a running work can hold completed + running steps)
export type StepStatus = "scheduled" | "running" | "completed" | "failed" | "timedOut" | "canceled";

// one activity invocation folded from its scheduled -> started -> terminal events
// parentId is null today (activities are siblings under root); kept so child-workflow steps nest under it later
export interface WorkflowStep {
  id: string;
  name: string;
  status: StepStatus;
  parentId: string | null;
  startedAt: string;
  detail: string | null;
  // intent decoded from the activity input; what makes two dispatchAgentTask steps tell themselves apart
  description: string | null;
  // the agent's final structured answer; null until the step's agentResult signal has landed
  response: string | null;
}

// default core until the real @temporalio/client adapter ships with the worker; tests always inject a fake
function notWiredCore(): TemporalCore {
  const fail = (): never => {
    throw new Error("temporal: no core wired — inject a TemporalCore (the @temporalio/client adapter lands with the worker, M7-9)");
  };
  return {
    connect: async () => fail(),
    start: async () => fail(),
    describe: async () => fail(),
    cancel: async () => fail(),
    terminate: async () => fail(),
    reset: async () => fail(),
    resetToStep: async () => fail(),
    result: async () => fail(),
    signal: async () => fail(),
    query: async () => fail(),
    history: async () => fail(),
    close: async () => {},
  };
}

// getSteps pairs the dispatch activity with its answer signal so a step isn't `completed` until the signal lands
const AGENT_DISPATCH_ACTIVITY = "dispatchAgentTask";
const AGENT_RESULT_SIGNAL = "agentResult";

// folds an activity-lifecycle event type onto the step status it implies; null for events that don't move a step
function mapStepStatus(type: string): StepStatus | null {
  switch (type) {
    case "ActivityTaskStarted":
      return "running";
    case "ActivityTaskCompleted":
      return "completed";
    case "ActivityTaskFailed":
      return "failed";
    case "ActivityTaskTimedOut":
      return "timedOut";
    case "ActivityTaskCanceled":
      return "canceled";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

// owns the single Temporal connection: starts executions, signals them, reflects state outward
// STATELESS — Temporal's visibility is authoritative, so it keeps no local instance map (unlike ZeebeClient)
export class TemporalClient {
  private readonly core: TemporalCore;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private started = false;
  private live = false;

  // core is injectable so tests run without a server; defaults to a not-wired core until the SDK adapter lands
  constructor(
    private readonly cfg: TemporalConfig,
    private readonly bus: Eventing,
    private readonly logger: ILogger,
    private readonly abortSignal: AbortSignal,
    core?: TemporalCore,
  ) {
    this.core = core ?? notWiredCore();
  }

  // resilient — a server down at boot schedules a retry, never throws up
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.abortSignal.addEventListener("abort", () => void this.stop(), { once: true });
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.abortSignal.aborted) return;
    try {
      await this.core.connect();
      this.live = true;
      this.logger.info("[temporal] connected to Temporal server");
    } catch (err) {
      // server unavailable at boot must not crash the process; back off and retry
      this.scheduleReconnect(err);
    }
  }

  private scheduleReconnect(err: unknown): void {
    if (this.abortSignal.aborted) return;
    const delay = Math.min(this.cfg.reconnectBaseMs, this.cfg.reconnectMaxMs);
    this.logger.warn(`[temporal] server unavailable (${String(err)}); retrying in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  // empty allowlist = unrestricted; a populated list gates starts to its members only
  private isEnabled(workflowType: string): boolean {
    return this.cfg.enabledWorkflowTypes.length === 0 || this.cfg.enabledWorkflowTypes.includes(workflowType);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  // start an execution; the Temporal WorkflowId IS our workId, so dedup is free and every later op keys by it
  async startProcess(workflowType: string, workId: string, variables: Record<string, unknown> = {}): Promise<ExecutionRecord> {
    if (!this.isEnabled(workflowType)) throw new WorkflowDisabledError(workflowType);
    const { runId } = await this.core.start({ workflowType, workflowId: workId, args: variables });
    // detached watcher: the WORKFLOW decides done/next, so the terminal event lands here when it returns, not at start
    this.watchResult(workId);
    return { workflowId: workId, runId, workflowType, status: "running", startedAt: Date.now() };
  }

  // await the terminal outcome and fold it onto the bus. cancel is published, NOT swallowed: the host's `stopped`
  // is only an ack and this confirmation advances it; it never resolves to `failed` so it can't overwrite with stuck
  private watchResult(workId: string): void {
    this.core
      .result(workId)
      .then((terminal) => {
        if (terminal.outcome === "completed") {
          this.bus.publish("workflow.completed", { temporalId: workId, result: terminal.result });
        } else if (terminal.outcome === "failed") {
          this.bus.publish("workflow.failed", { temporalId: workId, error: terminal.error });
        } else if (terminal.outcome === "canceled") {
          this.bus.publish("workflow.stopped", { temporalId: workId });
        }
      })
      .catch((err) => {
        // a watcher failure (not a workflow failure) must not be silent, but also must not crash the client
        this.logger.warn(`[temporal] result watch for ${workId} failed: ${String(err)}`);
      });
  }

  // graceful cancel (cooperative); the host's stop-work path
  async cancelProcess(workId: string): Promise<void> {
    await this.core.cancel(workId);
  }

  // forceful stop when a cancel will not settle
  async terminate(workId: string, reason: string): Promise<void> {
    await this.core.terminate(workId, reason);
  }

  // the reset spawns a NEW run (the original watcher resolved), so re-arm the terminal watcher
  async resetProcess(workId: string, reason = "re-execute stuck step"): Promise<void> {
    await this.core.reset(workId, reason);
    this.watchResult(workId);
  }

  // the reset spawns a NEW run (the original watcher resolved), so re-arm the terminal watcher
  async rerunFromStep(workId: string, stepId: string, reason = "rerun from step"): Promise<void> {
    await this.core.resetToStep(workId, stepId, reason);
    this.watchResult(workId);
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  // describe() is authoritative — no local reflection to read back (unlike the Zeebe client's instance map)
  async getInstance(workId: string): Promise<ExecutionRecord | undefined> {
    const d = await this.core.describe(workId);
    if (!d) return undefined;
    return { workflowId: workId, runId: d.runId, workflowType: d.workflowType, status: d.status, startedAt: 0 };
  }

  // read in-flight workflow state; no Camunda gRPC equivalent
  async query<T>(workId: string, name: string, args?: unknown): Promise<T> {
    return this.core.query<T>({ workflowId: workId, name, args });
  }

  // reconstruct steps from history: each activity folded from its scheduled -> started -> terminal events (grouped
  // by scheduledEventId), the last event setting the status; ordered by schedule time
  async getSteps(workId: string): Promise<WorkflowStep[]> {
    const events = await this.core.history(workId);
    const steps = new Map<string, WorkflowStep>();
    // the workflow serializes dispatch -> await answer, so the Nth signal answers the Nth dispatch (paired below)
    const dispatchSteps: WorkflowStep[] = [];
    const answers: { verdict?: string; response?: string }[] = [];
    let answeredCount = 0;
    for (const ev of events) {
      if (ev.type === "ActivityTaskScheduled") {
        const step: WorkflowStep = {
          id: ev.eventId,
          name: ev.activityType ?? "activity",
          status: "scheduled",
          parentId: null,
          startedAt: ev.timestamp,
          detail: null,
          description: ev.summary ?? null,
          response: null,
        };
        steps.set(ev.eventId, step);
        if (ev.activityType === AGENT_DISPATCH_ACTIVITY) dispatchSteps.push(step);
        continue;
      }
      if (ev.type === "WorkflowExecutionSignaled" && ev.signalName === AGENT_RESULT_SIGNAL) {
        answeredCount++;
        answers.push({ verdict: ev.verdict, response: ev.response });
        continue;
      }
      // a started/terminal event keys back to its scheduled event; skip if we never saw the schedule (torn history)
      const step = ev.scheduledEventId ? steps.get(ev.scheduledEventId) : undefined;
      if (!step) continue;
      step.status = mapStepStatus(ev.type) ?? step.status;
      if (ev.detail) step.detail = ev.detail;
    }
    // a dispatch activity is fire-and-forget, so ActivityTaskCompleted marks it `completed` too early — the real
    // round-trip is the agentResult signal: unanswered ones stay `running`, a non-success verdict is `failed`
    dispatchSteps.forEach((step, index) => {
      if (index >= answeredCount) {
        if (step.status === "completed") step.status = "running";
        return;
      }
      const answer = answers[index];
      if (answer?.verdict !== undefined && answer.verdict !== "success") step.status = "failed";
      if (answer?.response) step.response = answer.response;
    });
    return [...steps.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  // ---------------------------------------------------------------------------
  // Intervention
  // ---------------------------------------------------------------------------

  // operator intervention: inject variables onto a running execution as a Temporal Signal (Zeebe setVariables analog)
  async setVariables(workId: string, variables: Record<string, unknown>): Promise<void> {
    await this.core.signal({ workflowId: workId, name: "inject", payload: variables });
  }

  // generic signal seam for the control surface / future intervention events
  async signal(workId: string, name: string, payload: Record<string, unknown>): Promise<void> {
    await this.core.signal({ workflowId: workId, name, payload });
  }

  // just a named signal, NOT a job completion: the terminal publish lands with the worker once the Workflow returns.
  // outcome rides along when known so the workflow can fail a step; omitted when absent to keep the shape clean
  async reportResult(workId: string, result: unknown, outcome?: string): Promise<void> {
    const payload = outcome === undefined ? { result } : { result, outcome };
    await this.core.signal({ workflowId: workId, name: "agentResult", payload });
  }

  get connected(): boolean {
    return this.started && this.live;
  }

  // graceful: stop the reconnect timer and close the connection; never throws so shutdown keeps unwinding
  async stop(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      await this.core.close();
    } catch (err) {
      this.logger.warn(`[temporal] error during shutdown: ${String(err)}`);
    }
    this.live = false;
    this.started = false;
  }
}
