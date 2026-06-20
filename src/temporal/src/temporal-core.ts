import { randomUUID } from "node:crypto";
import {
  Connection,
  WorkflowClient,
  WorkflowNotFoundError,
  WorkflowFailedError,
  CancelledFailure,
  TerminatedFailure,
} from "@temporalio/client";
import type { TemporalConfig } from "./config.js";
import type { ExecutionStatus, HistoryEvent, TemporalCore } from "./temporal-client.js";

// Temporal carries eventId/scheduledEventId as Long and eventTime as a protobuf Timestamp; coerce both to plain
// JS without importing the `long` type — a Long exposes toNumber(), a plain number passes through unchanged.
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof (value as { toNumber?: () => number }).toNumber === "function") {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value ?? 0);
}

function toIso(ts: { seconds?: unknown; nanos?: number | null } | null | undefined): string {
  if (!ts) return new Date(0).toISOString();
  return new Date(toNumber(ts.seconds) * 1000 + Math.floor((ts.nanos ?? 0) / 1e6)).toISOString();
}

// Temporal proto enums.v1.ResetReapplyType.RESET_REAPPLY_TYPE_NONE — a stable wire enum value; reset with NONE so
// post-reset signals (the old agentResult answers) are NOT replayed and the rerun re-dispatches the step fresh.
const RESET_REAPPLY_NONE = 2;

// the activity's first input arg is the step's payload (dispatchAgentTask receives { workId, sessionId, prompt });
// decode the default JSON payload and surface the prompt so a step renders distinctly, not as the bare type.
function decodeActivitySummary(
  input: { payloads?: ({ data?: Uint8Array | null } | null)[] | null } | null | undefined,
): string | undefined {
  try {
    const data = input?.payloads?.[0]?.data;
    if (!data) return undefined;
    const arg = JSON.parse(Buffer.from(data).toString("utf8")) as { prompt?: unknown };
    return typeof arg.prompt === "string" ? arg.prompt : undefined;
  } catch {
    // a non-JSON or alternately-encoded payload just yields no summary; the step still renders by type
    return undefined;
  }
}

// Temporal's describe status names -> the engine-neutral ExecutionStatus the control surface returns.
// CONTINUED_AS_NEW reads as still running (the chain is live); anything unknown defaults to running, not a failure.
function mapStatus(name: string | undefined): ExecutionStatus {
  switch (name) {
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELED":
    case "CANCELLED":
      return "canceled";
    case "TERMINATED":
      return "terminated";
    case "TIMED_OUT":
      return "timedOut";
    default:
      return "running";
  }
}

// the real @temporalio/client adapter behind the TemporalCore seam (replaces notWiredCore once a server is up).
// constructed sync so mount stays sync; the network connection opens lazily in connect(), the only async-on-boot op.
export function createTemporalCore(cfg: TemporalConfig): TemporalCore {
  let connection: Connection | undefined;
  let client: WorkflowClient | undefined;

  // every op needs the WorkflowClient; fail loud rather than silently no-op if connect() never ran
  const need = (): WorkflowClient => {
    if (!client) throw new Error("temporal: core not connected — call connect() first");
    return client;
  };

  return {
    async connect(): Promise<void> {
      // the host presents its OWN service bearer (M7-10); omit metadata entirely when auth is off so insecure local works
      connection = await Connection.connect({
        address: cfg.address,
        metadata: cfg.authToken ? { authorization: `Bearer ${cfg.authToken}` } : undefined,
      });
      client = new WorkflowClient({ connection, namespace: cfg.namespace });
    },

    // workflowId IS our workId; variables ride as the workflow's single args object (matches userTableTestWorkflow(args))
    async start(req) {
      const handle = await need().start(req.workflowType, {
        taskQueue: cfg.taskQueue,
        workflowId: req.workflowId,
        args: [req.args],
      });
      return { runId: handle.firstExecutionRunId };
    },

    // a missing workflow is not an error here — the client maps undefined to a 404, never a 503
    async describe(workflowId) {
      try {
        const d = await need().getHandle(workflowId).describe();
        return { runId: d.runId, workflowType: d.type, status: mapStatus(d.status.name) };
      } catch (err) {
        if (err instanceof WorkflowNotFoundError) return undefined;
        throw err;
      }
    },

    // resolves when the workflow returns; classifies cancel/terminate apart from genuine failure so a user stop
    // never round-trips into `stuck` (handle.result() rejects for any non-completed terminal, hence the unwrap)
    async result(workflowId) {
      try {
        const value = await need().getHandle(workflowId).result();
        return { outcome: "completed", result: value };
      } catch (err) {
        if (err instanceof WorkflowFailedError && (err.cause instanceof CancelledFailure || err.cause instanceof TerminatedFailure)) {
          return { outcome: "canceled" };
        }
        return { outcome: "failed", error: String(err) };
      }
    },

    async cancel(workflowId) {
      await need().getHandle(workflowId).cancel();
    },

    async terminate(workflowId, reason) {
      await need().getHandle(workflowId).terminate(reason);
    },

    // Reset to the LAST workflow-task boundary (standard "LastWorkflowTask" semantics): re-running that task
    // re-schedules the most recent step's activity, so a stuck/failed step re-executes with identical inputs.
    // raw workflowService call — the high-level handle has no reset; the request keys by {workflowId, runId}.
    async reset(workflowId, reason) {
      const handle = need().getHandle(workflowId);
      const { runId } = await handle.describe();
      const history = await handle.fetchHistory();
      // the reset target must point at a WorkflowTaskStarted event; keep the LAST one in history
      const lastTask = (history.events ?? [])
        .filter((ev) => ev.workflowTaskStartedEventAttributes)
        .at(-1);
      if (!lastTask?.eventId) throw new Error(`temporal: ${workflowId} has no workflow-task to reset to`);
      const res = await connection!.workflowService.resetWorkflowExecution({
        namespace: cfg.namespace,
        workflowExecution: { workflowId, runId },
        reason,
        requestId: randomUUID(),
        workflowTaskFinishEventId: lastTask.eventId,
      });
      return { runId: res.runId };
    },

    // reset to the workflow-task that scheduled a chosen step: the LAST WorkflowTaskStarted before that step's
    // scheduled event. replaying that decision re-runs the step and everything after it; NONE drops the old answers.
    async resetToStep(workflowId, stepId, reason) {
      const handle = need().getHandle(workflowId);
      const { runId } = await handle.describe();
      const history = await handle.fetchHistory();
      const target = toNumber(stepId);
      const boundary = (history.events ?? [])
        .filter((ev) => ev.workflowTaskStartedEventAttributes && toNumber(ev.eventId) < target)
        .at(-1);
      if (!boundary?.eventId) throw new Error(`temporal: ${workflowId} has no workflow-task before step ${stepId}`);
      const res = await connection!.workflowService.resetWorkflowExecution({
        namespace: cfg.namespace,
        workflowExecution: { workflowId, runId },
        reason,
        requestId: randomUUID(),
        workflowTaskFinishEventId: boundary.eventId,
        resetReapplyType: RESET_REAPPLY_NONE,
      });
      return { runId: res.runId };
    },

    // payload is delivered as the signal's single argument (agentResult expects {result}, inject expects the vars record)
    async signal(req) {
      await need().getHandle(req.workflowId).signal(req.name, req.payload);
    },

    async query<T>(req: { workflowId: string; name: string; args?: unknown }): Promise<T> {
      return (await need().getHandle(req.workflowId).query(req.name, req.args)) as T;
    },

    // map the raw protobuf history to engine-neutral records, keeping only the activity-lifecycle events steps are
    // built from; the client groups these by scheduledEventId. fetchHistory is the same call reset already uses.
    async history(workflowId): Promise<HistoryEvent[]> {
      const history = await need().getHandle(workflowId).fetchHistory();
      const out: HistoryEvent[] = [];
      for (const ev of history.events ?? []) {
        const eventId = String(toNumber(ev.eventId));
        const timestamp = toIso(ev.eventTime);
        const sched = ev.activityTaskScheduledEventAttributes;
        const started = ev.activityTaskStartedEventAttributes;
        const completed = ev.activityTaskCompletedEventAttributes;
        const failed = ev.activityTaskFailedEventAttributes;
        const timedOut = ev.activityTaskTimedOutEventAttributes;
        const canceled = ev.activityTaskCanceledEventAttributes;
        if (sched) {
          out.push({
            eventId,
            timestamp,
            type: "ActivityTaskScheduled",
            activityType: sched.activityType?.name ?? undefined,
            summary: decodeActivitySummary(sched.input),
          });
        } else if (started) {
          out.push({ eventId, timestamp, type: "ActivityTaskStarted", scheduledEventId: String(toNumber(started.scheduledEventId)) });
        } else if (completed) {
          out.push({ eventId, timestamp, type: "ActivityTaskCompleted", scheduledEventId: String(toNumber(completed.scheduledEventId)) });
        } else if (failed) {
          out.push({ eventId, timestamp, type: "ActivityTaskFailed", scheduledEventId: String(toNumber(failed.scheduledEventId)), detail: failed.failure?.message ?? undefined });
        } else if (timedOut) {
          out.push({ eventId, timestamp, type: "ActivityTaskTimedOut", scheduledEventId: String(toNumber(timedOut.scheduledEventId)) });
        } else if (canceled) {
          out.push({ eventId, timestamp, type: "ActivityTaskCanceled", scheduledEventId: String(toNumber(canceled.scheduledEventId)) });
        }
      }
      return out;
    },

    async close(): Promise<void> {
      await connection?.close();
      connection = undefined;
      client = undefined;
    },
  };
}
