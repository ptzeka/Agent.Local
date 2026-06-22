import { randomUUID } from "node:crypto";
import type { Eventing, ILogger } from "@agent-local/common";
import {
  WORKFLOW_START,
  WORKFLOW_STARTED,
  WORKFLOW_STOP,
  WORKFLOW_STOPPED,
  WORKFLOW_INJECT,
  WORKFLOW_RETRY,
  WORKFLOW_RESET,
  WORKFLOW_COMPLETED,
  WORKFLOW_FAILED,
  WORKFLOW_DESCRIBE,
  WORKFLOW_STATUS,
  type WorkflowStartedPayload,
  type WorkflowStoppedPayload,
  type WorkflowCompletedPayload,
  type WorkflowFailedPayload,
  type WorkflowStatusPayload,
} from "../events.js";
import type { WorkRecord, WorkStatus } from "../work/work-store.js";
import type { WorkStore } from "../work/work-store.js";
import type { AgentClient } from "../comms/sender.js";

// the SINGLE place that maps the engine's authoritative status (Temporal's describe, or `missing` when it holds no
// such execution) onto the host lifecycle: the status to fold plus the human description the row shows. Returns
// null for states a reconcile must NOT fold — still running, or a clean completion the push path owns. Every
// non-clean terminal (missing / failed / timedOut / terminated / canceled) folds to `stopped`, the recoverable end.
export function resolveEngineStatus(
  engineStatus: string | undefined,
  missing: boolean | undefined,
): { status: WorkStatus; description: string } | null {
  if (missing) return { status: "stopped", description: "no running workflow found on the engine" };
  switch (engineStatus) {
    case "canceled":
      return { status: "stopped", description: "cancellation confirmed by the engine" };
    case "failed":
    case "timedOut":
    case "terminated":
      return { status: "stopped", description: `engine reported ${engineStatus}` };
    default:
      return null; // running / completed / unknown: in-flight or owned by the push path
  }
}

// owns the work unit's lifecycle: the join no single engine holds. trigger() provisions it up front (mint
// ids -> open the agent session -> command the start), then the bus updaters fold each engine event back
// onto the store. Couples to the engines ONLY through the bus, except ctx.works which IS the host's state.
export class WorkService {
  constructor(
    private readonly bus: Eventing,
    private readonly works: WorkStore,
    private readonly agent: AgentClient,
    private readonly logger: ILogger,
  ) {}

  // wire the registry updaters: engine live -> store temporalId; terminal -> close the session, set status
  start(): void {
    this.bus.subscribe(WORKFLOW_STARTED, (event) => {
      const { workId, temporalId } = event.payload as unknown as WorkflowStartedPayload;
      void this.works.update(workId, { temporalId, status: "running" });
    });

    this.bus.subscribe(WORKFLOW_COMPLETED, (event) => {
      const { temporalId, result } = event.payload as unknown as WorkflowCompletedPayload;
      void this.complete(temporalId, result);
    });

    this.bus.subscribe(WORKFLOW_FAILED, (event) => {
      const { temporalId, error } = event.payload as unknown as WorkflowFailedPayload;
      if (temporalId) void this.markFailed(temporalId, error);
    });

    // the engine confirmed the user's stop settled: run the post-stop cleanup (the work already reads `stopped`)
    this.bus.subscribe(WORKFLOW_STOPPED, (event) => {
      const { temporalId } = event.payload as unknown as WorkflowStoppedPayload;
      if (temporalId) void this.onStopConfirmed(temporalId);
    });

    // the engine's answer to a reconcile request: fold the authoritative state back onto the in-flight job
    this.bus.subscribe(WORKFLOW_STATUS, (event) => {
      const { workId, status, missing } = event.payload as unknown as WorkflowStatusPayload;
      void this.reconcile(workId, status, missing);
    });
  }

  // poll-time reconcile: the API asks the engine for a work's live state over the bus (bus-pure — the host holds
  // no engine client). The answer arrives async as WORKFLOW_STATUS, so THIS read returns the current record and
  // the next poll reflects the fold; the job is keyed by workId, which is the engine id for our work units.
  public requestReconcile(workId: string): void {
    this.bus.publish(WORKFLOW_DESCRIBE, { workId });
  }

  // provisions a new work unit owned by userId and commands its start; returns the workId the caller queries by.
  // the agent session is opened under the host's OWN agent:trigger service token (see HttpJobSender), not the caller's.
  async trigger(workflowId: string, userId: string): Promise<string> {
    const workId = randomUUID();
    const workspaceId = randomUUID();
    await this.works.add(workId, userId, workflowId, workspaceId);
    const sessionId = await this.agent.createSession(workspaceId, workId);
    await this.works.update(workId, { sessionId });
    this.bus.publish(WORKFLOW_START, { workId, workspaceId, sessionId, workflowId });
    return workId;
  }

  // stops a work the caller owns: command the engine cancel (bus -> engine) and record `stopped` (the recoverable
  // terminal) as the ACK. Cleanup (close the agent session) is deferred to finalizeStop, which runs only once the
  // engine CONFIRMS the cancel — so the session is not released while the workflow may still be alive. The
  // confirmation arrives as workflow.stopped (push) or via reconcile-on-refresh.
  async stop(workId: string, userId: string, reason: string): Promise<WorkRecord | null> {
    const record = await this.works.get(workId);
    if (!record || record.userId !== userId) return null;
    if (record.temporalId) this.bus.publish(WORKFLOW_STOP, { workId, temporalId: record.temporalId });
    return this.works.update(workId, { status: "stopped", step: reason });
  }

  // operator intervention: inject variables onto a work the caller owns (camunda must be live). returns the work
  // record so the route can 404 a non-owner, false when the instance has not started. bus-pure like stop.
  async inject(
    workId: string,
    userId: string,
    variables: Record<string, unknown>,
    opts: { scopeKey?: string; local?: boolean } = {},
  ): Promise<WorkRecord | null | false> {
    const record = await this.works.get(workId);
    if (!record || record.userId !== userId) return null;
    if (!record.temporalId) return false;
    this.bus.publish(WORKFLOW_INJECT, { temporalId: record.temporalId, variables, ...opts });
    return record;
  }

  // operator "continue": pick a stopped work back up — re-execute its last step via engine Reset. ownership by
  // workId; only a `stopped` work is resettable (a clean `completed` is done; the engine refuses a running one).
  // returns null for a non-owner, false when the work is not stopped. status goes back to `running` as the new run boots.
  async continue(workId: string, userId: string): Promise<WorkRecord | null | false> {
    const record = await this.works.get(workId);
    if (!record || record.userId !== userId) return null;
    if (record.status !== "stopped") return false;
    this.bus.publish(WORKFLOW_RESET, { workId });
    return this.works.update(workId, { status: "running", step: "re-executing stopped step" });
  }

  // operator "rerun from step": re-execute a work from a chosen step via engine Reset (re-runs that step and
  // everything after, dropping old answers). ownership by workId; unlike continue() it is NOT gated to `stopped` — a
  // past step of a completed work is rerunnable too. the engine still refuses while the run is live. status goes
  // back to `running` as the new run boots; null for a non-owner.
  async rerunStep(workId: string, userId: string, stepId: string): Promise<WorkRecord | null> {
    const record = await this.works.get(workId);
    if (!record || record.userId !== userId) return null;
    this.bus.publish(WORKFLOW_RESET, { workId, stepId });
    return this.works.update(workId, { status: "running", step: `re-running from step ${stepId}` });
  }

  // operator intervention: retry a failed step of a work the caller owns, keyed by the jobKey the caller supplies
  // (from the failed-work detail). ownership is by workId; the engine does the broker retry. bus-pure like stop.
  async retryStep(
    workId: string,
    userId: string,
    jobKey: string,
    opts: { incidentKey?: string; retries?: number } = {},
  ): Promise<WorkRecord | null> {
    const record = await this.works.get(workId);
    if (!record || record.userId !== userId) return null;
    this.bus.publish(WORKFLOW_RETRY, { jobKey, ...opts });
    return record;
  }

  // terminal SUCCESS: the engine returned, so close the agent session (post-workflow cleanup) and settle to
  // `completed` — the clean, non-recoverable end. sessionId is cleared so a settled work stops reconciling.
  private async complete(temporalId: string, result: unknown): Promise<void> {
    const record = await this.byTemporalId(temporalId);
    if (!record) return;
    const description = result == null ? null : String(result);
    if (record.sessionId) await this.agent.closeSession(record.sessionId);
    await this.works.update(record.workId, { status: "completed", step: description });
  }

  // a failed/absent workflow settles to `stopped` (the recoverable terminal), with the engine's error as the row's
  // context. close the session like any stop — the recovery path is a Reset (continue/rerun), which rebuilds it.
  public async markFailed(temporalId: string, error: string): Promise<void> {
    const record = await this.byTemporalId(temporalId);
    if (!record) return;
    if (record.sessionId) await this.agent.closeSession(record.sessionId);
    await this.works.update(record.workId, { status: "stopped", step: error });
  }

  // engine confirmed the cancel: resolve the work by its engine id, then finalize the stop
  private async onStopConfirmed(temporalId: string): Promise<void> {
    const record = await this.byTemporalId(temporalId);
    if (record) await this.finalizeStop(record);
  }

  // post-stop cleanup: the work already reads `stopped` (set at the stop ACK); this just closes the agent session
  // once the engine confirms the cancel (workflow.stopped) OR a reconcile finds the run gone, so a missed
  // confirmation still heals on refresh. idempotent via sessionId: clearing it on close makes a re-run a no-op AND
  // stops the work reconciling. a `completed` work never reaches here (the reconcile gate excludes it).
  private async finalizeStop(record: WorkRecord): Promise<void> {
    if (!record.sessionId) return;
    await this.agent.closeSession(record.sessionId);
    await this.works.update(record.workId, { sessionId: null });
  }

  // fold a reconcile answer onto the record — the recovery net for push events the host may have missed (e.g. a
  // restart dropped the in-memory result watcher). Only NON-settled works reconcile: in-flight (new/running) and a
  // `stopped` work whose post-stop cleanup is still pending (sessionId set). resolveEngineStatus is the single
  // status/description authority; an already-stopped work only needs its cleanup run, not another status fold.
  private async reconcile(workId: string, status: string | undefined, missing: boolean | undefined): Promise<void> {
    const record = await this.works.get(workId);
    if (!record) return;
    // a stopped work is terminal — only run its deferred cleanup (close the session the engine has now released)
    if (record.status === "stopped") {
      await this.finalizeStop(record);
      return;
    }
    if (record.status !== "new" && record.status !== "running") return;
    const resolved = resolveEngineStatus(status, missing);
    if (!resolved) return;
    await this.works.update(workId, { status: resolved.status, step: resolved.description });
  }

  // the work unit carries the engine id as temporalId (== our workId); fold terminal events back by it
  private async byTemporalId(temporalId: string): Promise<WorkRecord | undefined> {
    return (await this.works.search()).find((r) => r.temporalId === temporalId);
  }
}
