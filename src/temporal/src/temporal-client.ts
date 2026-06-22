import type { Eventing } from "@agent-local/common";
import type { ILogger } from "@agent-local/common/ilogger";
import type { TemporalConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Temporal execution status normalized to the engine-neutral shape the control surface returns
export type ExecutionStatus = "running" | "completed" | "failed" | "canceled" | "terminated" | "timedOut";

// the terminal outcome of awaiting a workflow: `completed` carries the return value; `canceled` is a user stop
// (no terminal publish — the host already recorded it); `failed` carries the error for the host to mark stuck
export type TerminalOutcome =
  | { outcome: "completed"; result: unknown }
  | { outcome: "canceled" }
  | { outcome: "failed"; error: string };

// @temporalio/client is handle-oriented and typed loosely across versions; pin the few ops we call behind a local
// shape so tests inject a fake and the real SDK adapter lands later with the worker ("add workflow later", M7-9)
export interface TemporalCore {
  connect(): Promise<void>;
  start(req: { workflowType: string; workflowId: string; args: Record<string, unknown> }): Promise<{ runId: string }>;
  describe(workflowId: string): Promise<{ runId: string; workflowType: string; status: ExecutionStatus } | undefined>;
  cancel(workflowId: string): Promise<void>;
  terminate(workflowId: string, reason: string): Promise<void>;
  // reset re-runs the workflow from its last workflow-task boundary, re-executing the most recent step with the
  // same inputs; returns the new runId. the engine refuses a reset on a still-running execution by design.
  reset(workflowId: string, reason: string): Promise<{ runId: string }>;
  // reset to the boundary just before a chosen step's scheduled event, so that step (and everything after it)
  // re-runs; post-reset signals are dropped so the rerun re-dispatches fresh rather than replaying old answers
  resetToStep(workflowId: string, stepId: string, reason: string): Promise<{ runId: string }>;
  // awaits the workflow's terminal outcome; `canceled` is folded apart from `failed` so a user stop never
  // overwrites the host's `stopped` with `stuck` (the adapter classifies cancel/terminate as canceled)
  result(workflowId: string): Promise<TerminalOutcome>;
  signal(req: { workflowId: string; name: string; payload: Record<string, unknown> }): Promise<void>;
  query<T>(req: { workflowId: string; name: string; args?: unknown }): Promise<T>;
  // the execution's full event history, mapped to engine-neutral records the client folds into steps
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

// engine truth for one execution; Temporal's visibility owns real state, this is the shape we expose outward
export interface ExecutionRecord {
  workflowId: string;
  runId: string;
  workflowType: string;
  status: ExecutionStatus;
  startedAt: number;
}

// one Temporal history event, narrowed to the activity-lifecycle fields step reconstruction needs. engine-neutral
// so the client groups these into steps without importing the SDK's protobuf event shapes (the core does that map)
export interface HistoryEvent {
  eventId: string;
  type: string;
  timestamp: string;
  scheduledEventId?: string;
  activityType?: string;
  detail?: string;
  // a scheduled event's decoded intent (our dispatchAgentTask passes the step's prompt) — distinguishes steps
  // that otherwise all read as the bare activity type
  summary?: string;
  // the signal name on a WorkflowExecutionSignaled event; `agentResult` marks one step's round-trip answered
  signalName?: string;
}

// the engine's own activity status for a step — deliberately NOT the host work-status catalog, which describes the
// overall work, not its individual steps (a running work can hold a completed and a running step at once)
export type StepStatus = "scheduled" | "running" | "completed" | "failed" | "timedOut" | "canceled";

// a reconstructed work step: one activity invocation folded from its scheduled -> started -> terminal events.
// parentId is null today (activities are siblings under the root); kept so child-workflow steps nest under it later.
export interface WorkflowStep {
  id: string;
  name: string;
  status: StepStatus;
  parentId: string | null;
  startedAt: string;
  detail: string | null;
  // the step's intent decoded from the activity input (the dispatched prompt); null when the input carried none.
  // `name` stays the activity type; this is what makes two dispatchAgentTask steps tell themselves apart.
  description: string | null;
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

// the dispatch activity (createAgentActivities in workflows/activities.ts) and the answer signal it round-trips to
// (TemporalClient.reportResult). getSteps pairs them so a step isn't `completed` until its answer signal lands.
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
// ownership is the host's concern (WorkStore keyed by userId), never the engine's
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

  // boot: connect; resilient — a server down at boot schedules a retry, never throws up
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

  // await the workflow's terminal outcome and fold it onto the bus: a return value -> workflow.completed (the host
  // marks done -> complete), a failure -> workflow.failed (the host marks stuck), a user cancel -> workflow.stopped
  // (the host runs its post-stop cleanup and settles `cancelled`). cancel is published, NOT swallowed: the host's
  // `stopped` is only an ack — this confirmation is what advances it. it never resolves to `failed`, so it cannot
  // overwrite the stop with stuck.
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

  // re-execute a stuck work: Reset re-runs the failed step with the same parameters. the reset spawns a NEW run,
  // so re-arm the terminal watcher to fold its completion/failure back onto the bus (the original watcher resolved)
  async resetProcess(workId: string, reason = "re-execute stuck step"): Promise<void> {
    await this.core.reset(workId, reason);
    this.watchResult(workId);
  }

  // rerun a work from a chosen step: Reset to the boundary before that step, re-running it and everything after.
  // the reset spawns a NEW run (the original watcher resolved), so re-arm the terminal watcher to fold its outcome.
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

  // reconstruct the work's steps from Temporal history: each activity invocation is one step, folded from its
  // scheduled -> started -> terminal events (grouped by the scheduledEventId those later events carry). the last
  // event for a group sets the status, so a terminal supersedes the earlier running/scheduled. ordered by schedule time.
  async getSteps(workId: string): Promise<WorkflowStep[]> {
    const events = await this.core.history(workId);
    const steps = new Map<string, WorkflowStep>();
    // dispatch steps in schedule order, paired against the agentResult signals as they arrive — the workflow
    // serializes dispatch -> await answer, so the Nth signal answers the Nth dispatch (see user-table-test.ts)
    const dispatchSteps: WorkflowStep[] = [];
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
        };
        steps.set(ev.eventId, step);
        if (ev.activityType === AGENT_DISPATCH_ACTIVITY) dispatchSteps.push(step);
        continue;
      }
      if (ev.type === "WorkflowExecutionSignaled" && ev.signalName === AGENT_RESULT_SIGNAL) {
        answeredCount++;
        continue;
      }
      // a started/terminal event keys back to its scheduled event; skip if we never saw the schedule (torn history)
      const step = ev.scheduledEventId ? steps.get(ev.scheduledEventId) : undefined;
      if (!step) continue;
      step.status = mapStepStatus(ev.type) ?? step.status;
      if (ev.detail) step.detail = ev.detail;
    }
    // a dispatch activity is fire-and-forget (it returns the instant the job is published), so ActivityTaskCompleted
    // marks it `completed` too early — the real round-trip lands as the agentResult signal. Hold every dispatch past
    // the answered count at `running`: it has dispatched but the agent has not answered yet.
    dispatchSteps.forEach((step, index) => {
      if (step.status === "completed" && index >= answeredCount) step.status = "running";
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

  // the agent reports results back; the WORKFLOW decides done/next. just a named signal — NOT a job completion,
  // so it does NOT publish workflow.completed: the terminal publish lands with the worker once the Workflow returns.
  // outcome (the turn's success/failure verdict) rides along when known so the workflow can fail a step on a
  // non-satisfied turn; omitted from the payload when absent to keep the signal shape clean.
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
