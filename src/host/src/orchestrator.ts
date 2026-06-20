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
} from "./events.js";
import type { JobRecord, JobStatus } from "./jobs/job-registry.js";
import type { JobRegistry } from "./jobs/job-registry.js";
import type { AgentClient } from "./comms/sender.js";

// the SINGLE place that maps the engine's authoritative status (Temporal's describe, or `missing` when it holds no
// such execution) onto the host lifecycle: the status to fold plus the human description the row shows. Returns
// null for states a reconcile must NOT fold — still running, or a clean completion the push path owns. Recovery
// rules: missing / failed / timedOut / terminated -> stuck (recoverable); a confirmed cancel -> cancelled.
export function resolveEngineStatus(
  engineStatus: string | undefined,
  missing: boolean | undefined,
): { status: JobStatus; description: string } | null {
  if (missing) return { status: "stuck", description: "no running workflow found on the engine" };
  switch (engineStatus) {
    case "canceled":
      return { status: "cancelled", description: "cancellation confirmed by the engine" };
    case "failed":
    case "timedOut":
    case "terminated":
      return { status: "stuck", description: `engine reported ${engineStatus}` };
    default:
      return null; // running / completed / unknown: in-flight or owned by the push path
  }
}

// owns the work unit's lifecycle: the join no single engine holds. trigger() provisions it up front (mint
// ids -> open the agent session -> command the start), then the bus updaters fold each engine event back
// onto the registry. Couples to the engines ONLY through the bus, except ctx.jobs which IS the host's state.
export class Orchestrator {
  constructor(
    private readonly bus: Eventing,
    private readonly jobs: JobRegistry,
    private readonly agent: AgentClient,
    private readonly logger: ILogger,
  ) {}

  // wire the registry updaters: engine live -> store temporalId; terminal -> close the session, set status
  start(): void {
    this.bus.subscribe(WORKFLOW_STARTED, (event) => {
      const { workId, temporalId } = event.payload as unknown as WorkflowStartedPayload;
      void this.jobs.update(workId, { temporalId, status: "running" });
    });

    this.bus.subscribe(WORKFLOW_COMPLETED, (event) => {
      const { temporalId, result } = event.payload as unknown as WorkflowCompletedPayload;
      void this.complete(temporalId, result);
    });

    this.bus.subscribe(WORKFLOW_FAILED, (event) => {
      const { temporalId, error } = event.payload as unknown as WorkflowFailedPayload;
      if (temporalId) void this.markStuck(temporalId, error);
    });

    // the engine confirmed the user's stop settled: run the post-stop cleanup and advance `stopped` -> `cancelled`
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
    await this.jobs.add(workId, userId, workflowId, workspaceId);
    const sessionId = await this.agent.createSession(workspaceId, workId);
    await this.jobs.update(workId, { sessionId });
    this.bus.publish(WORKFLOW_START, { workId, workspaceId, sessionId, workflowId });
    return workId;
  }

  // stops a work the caller owns — phase 1 of two: command the engine cancel (bus -> engine) and record `stopped`
  // as an ACK, nothing more. Cleanup (close the agent session) and the terminal `cancelled` are deferred to
  // finalizeStop, which runs only once the engine CONFIRMS the cancel — so resources are not released while the
  // workflow may still be alive. The confirmation arrives as workflow.stopped (push) or via reconcile-on-refresh.
  async stop(workId: string, userId: string, reason: string): Promise<JobRecord | null> {
    const record = await this.jobs.get(workId);
    if (!record || record.userId !== userId) return null;
    if (record.temporalId) this.bus.publish(WORKFLOW_STOP, { workId, temporalId: record.temporalId });
    return this.jobs.update(workId, { status: "stopped", statusDescription: reason });
  }

  // operator intervention: inject variables onto a work the caller owns (camunda must be live). returns the work
  // record so the route can 404 a non-owner, false when the instance has not started. bus-pure like stop.
  async inject(
    workId: string,
    userId: string,
    variables: Record<string, unknown>,
    opts: { scopeKey?: string; local?: boolean } = {},
  ): Promise<JobRecord | null | false> {
    const record = await this.jobs.get(workId);
    if (!record || record.userId !== userId) return null;
    if (!record.temporalId) return false;
    this.bus.publish(WORKFLOW_INJECT, { temporalId: record.temporalId, variables, ...opts });
    return record;
  }

  // operator "continue": re-execute a stuck work's failed step via engine Reset. ownership by workId; only a
  // `stuck` work is resettable (the engine refuses a running one anyway). returns null for a non-owner, false
  // when the work is not stuck. bus-pure like stop/inject; status goes back to `running` as the new run boots.
  async continue(workId: string, userId: string): Promise<JobRecord | null | false> {
    const record = await this.jobs.get(workId);
    if (!record || record.userId !== userId) return null;
    if (record.status !== "stuck") return false;
    this.bus.publish(WORKFLOW_RESET, { workId });
    return this.jobs.update(workId, { status: "running", statusDescription: "re-executing stuck step" });
  }

  // operator "rerun from step": re-execute a work from a chosen step via engine Reset (re-runs that step and
  // everything after, dropping old answers). ownership by workId; unlike continue() it is NOT gated to `stuck` — a
  // past step of a done/cancelled work is rerunnable too. the engine still refuses while the run is live. status
  // goes back to `running` as the new run boots; null for a non-owner.
  async rerunStep(workId: string, userId: string, stepId: string): Promise<JobRecord | null> {
    const record = await this.jobs.get(workId);
    if (!record || record.userId !== userId) return null;
    this.bus.publish(WORKFLOW_RESET, { workId, stepId });
    return this.jobs.update(workId, { status: "running", statusDescription: `re-running from step ${stepId}` });
  }

  // operator intervention: retry a failed step of a work the caller owns, keyed by the jobKey the caller supplies
  // (from the failed-work detail). ownership is by workId; the engine does the broker retry. bus-pure like stop.
  async retryStep(
    workId: string,
    userId: string,
    jobKey: string,
    opts: { incidentKey?: string; retries?: number } = {},
  ): Promise<JobRecord | null> {
    const record = await this.jobs.get(workId);
    if (!record || record.userId !== userId) return null;
    this.bus.publish(WORKFLOW_RETRY, { jobKey, ...opts });
    return record;
  }

  // terminal SUCCESS, two-phase: `done` the instant the engine signals the workflow returned, THEN run the host's
  // post-workflow tasks (close the agent session) and only then `complete` — so the two states are observable apart.
  private async complete(temporalId: string, result: unknown): Promise<void> {
    const record = await this.byTemporalId(temporalId);
    if (!record) return;
    const description = result == null ? null : String(result);
    await this.jobs.update(record.jobId, { status: "done", statusDescription: description });
    if (record.sessionId) await this.agent.closeSession(record.sessionId);
    await this.jobs.update(record.jobId, { status: "complete", statusDescription: description });
  }

  // a failed/absent workflow is `stuck`, with the engine's error as the live context (the error/missing-info
  // display). recoverable via inject/retry, so it is NOT terminal — the session is left for the recovery path.
  public async markStuck(temporalId: string, error: string): Promise<void> {
    const record = await this.byTemporalId(temporalId);
    if (!record) return;
    await this.jobs.update(record.jobId, { status: "stuck", statusDescription: error });
  }

  // engine confirmed the cancel: resolve the work by its engine id, then finalize the stop
  private async onStopConfirmed(temporalId: string): Promise<void> {
    const record = await this.byTemporalId(temporalId);
    if (record) await this.finalizeStop(record);
  }

  // terminal STOP, phase 2 of two — the mirror of complete(): close the agent session (post-stop cleanup) then
  // settle to `cancelled`, keeping the stop reason as the description. driven by the engine's cancel confirmation
  // (workflow.stopped) OR by a reconcile that finds the execution cancelled, so a missed confirmation still heals
  // on refresh. idempotent: a work already in a terminal state is left untouched (double-confirm is a no-op).
  private async finalizeStop(record: JobRecord): Promise<void> {
    if (record.status === "cancelled" || record.status === "done" || record.status === "complete") return;
    if (record.sessionId) await this.agent.closeSession(record.sessionId);
    await this.jobs.update(record.jobId, { status: "cancelled" });
  }

  // fold a reconcile answer onto the record — the recovery net for push events the host may have missed (e.g. a
  // restart dropped the in-memory result watcher). Only NON-settled works reconcile: in-flight (new/running) and a
  // pending stop awaiting its cancel confirmation. resolveEngineStatus is the single status/description authority;
  // a confirmed cancel runs the post-stop cleanup (finalizeStop), everything else folds straight on.
  private async reconcile(workId: string, status: string | undefined, missing: boolean | undefined): Promise<void> {
    const record = await this.jobs.get(workId);
    if (!record) return;
    if (record.status !== "new" && record.status !== "running" && record.status !== "stopped") return;
    const resolved = resolveEngineStatus(status, missing);
    if (!resolved) return;
    // a pending stop settles the instant the engine reports the run is no longer active — an explicit cancel, a
    // missing run (e.g. it never started, temporalId null), or any terminal. The user asked to stop, so finalize
    // to `cancelled`, NEVER `stuck`: stuck is only for an in-flight work the engine orphaned, not one already stopped.
    if (record.status === "stopped" || resolved.status === "cancelled") {
      await this.finalizeStop(record);
      return;
    }
    await this.jobs.update(workId, { status: resolved.status, statusDescription: resolved.description });
  }

  // the work unit carries the engine id as temporalId (== our workId); fold terminal events back by it
  private async byTemporalId(temporalId: string): Promise<JobRecord | undefined> {
    return (await this.jobs.search()).find((r) => r.temporalId === temporalId);
  }
}
