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
import type { ExecutionStatus, TemporalCore } from "./temporal-client.js";

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

    // payload is delivered as the signal's single argument (agentResult expects {result}, inject expects the vars record)
    async signal(req) {
      await need().getHandle(req.workflowId).signal(req.name, req.payload);
    },

    async query<T>(req: { workflowId: string; name: string; args?: unknown }): Promise<T> {
      return (await need().getHandle(req.workflowId).query(req.name, req.args)) as T;
    },

    async close(): Promise<void> {
      await connection?.close();
      connection = undefined;
      client = undefined;
    },
  };
}
