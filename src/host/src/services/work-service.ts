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
  AGENT_RESULT,
  type WorkflowStartedPayload,
  type WorkflowStoppedPayload,
  type WorkflowCompletedPayload,
  type WorkflowFailedPayload,
  type WorkflowStatusPayload,
  type AgentResultPayload,
} from "../events.js";
import type { WorkRecord, WorkStatus } from "../work/work-store.js";
import type { WorkStore } from "../work/work-store.js";
import { isTerminalStatus } from "../work/work-status.js";
import type { AgentClient, StepSessionResolver } from "../comms/sender.js";

// the SINGLE place that RECALCULATES a work's status from the engine's authoritative status (Temporal's describe, or
// `missing` when it holds no such execution). This is a total recompute, NOT a one-way latch: a live `running` run
// maps back to `running`, so a work that was `attention` returns to `running` once its workflow is active again
// (e.g. later steps fired after an earlier one was canceled). Every non-clean end — `canceled`, a run the engine no
// longer holds, or `failed`/`timedOut`/`terminated` — maps to the single non-terminal stopped state, `attention`. A
// clean stop carries a NULL description (just the status; the per-step Temporal status shows what happened); a
// failure keeps the engine reason. `completed` returns null — the push path (WORKFLOW_COMPLETED) owns the clean
// finish and its result text, so reconcile never overwrites it.
export function resolveEngineStatus(
  engineStatus: string | undefined,
  missing: boolean | undefined,
): { status: WorkStatus; description: string | null } | null {
  if (missing) return { status: "attention", description: null };
  switch (engineStatus) {
    case "running":
      return { status: "running", description: null };
    case "canceled":
      return { status: "attention", description: null };
    case "failed":
    case "timedOut":
    case "terminated":
      return { status: "attention", description: `engine reported ${engineStatus}` };
    default:
      return null; // completed (push path owns it) / unknown: leave as-is
  }
}

// owns the work unit's lifecycle: the join no single engine holds. trigger() provisions it up front (mint
// ids -> open the agent session -> command the start), then the bus updaters fold each engine event back
// onto the store. Couples to the engines ONLY through the bus, except ctx.works which IS the host's state.
export class WorkService implements StepSessionResolver {
  constructor(
    private readonly bus: Eventing,
    private readonly works: WorkStore,
    private readonly agent: AgentClient,
    private readonly logger: ILogger,
  ) {}

  // wire the registry updaters: engine live -> store temporalId; terminal -> close the sessions, set status
  start(): void {
    this.bus.subscribe(WORKFLOW_STARTED, (event) => {
      const { workId, temporalId } = event.payload as unknown as WorkflowStartedPayload;
      void this.works.update(workId, { temporalId, status: "running" });
    });

    // a step's answer landed -> its per-step session is done (success or fail); release it now so only live steps
    // hold a session. The work's terminal/stop path still sweeps any that never answered.
    this.bus.subscribe(AGENT_RESULT, (event) => {
      const { sessionId } = event.payload as unknown as AgentResultPayload;
      if (sessionId) void this.close(sessionId);
    });

    this.bus.subscribe(WORKFLOW_COMPLETED, (event) => {
      const { temporalId, result } = event.payload as unknown as WorkflowCompletedPayload;
      void this.complete(temporalId, result);
    });

    this.bus.subscribe(WORKFLOW_FAILED, (event) => {
      const { temporalId, error } = event.payload as unknown as WorkflowFailedPayload;
      if (temporalId) void this.markFailed(temporalId, error);
    });

    // the engine confirmed the cancel settled: THIS event drives the status — settle the work to `attention` + cleanup
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
  // No session is minted here anymore: each STEP gets its own session at dispatch (see open()), so a work starts
  // with zero agent sessions and accrues one per dispatched step.
  async trigger(workflowId: string, userId: string): Promise<string> {
    const workId = randomUUID();
    const workspaceId = randomUUID();
    await this.works.add(workId, userId, workflowId, workspaceId);
    this.bus.publish(WORKFLOW_START, { workId, workspaceId, workflowId });
    return workId;
  }

  // ---------------------------------------------------------------------------
  // Per-step sessions (StepSessionResolver)
  // ---------------------------------------------------------------------------

  // bind a fresh agent session to one dispatched step, under the host's OWN agent:trigger service token. Idempotent
  // per (workId, runKey, stepKey) so a Temporal activity retry reuses the same session instead of minting a second.
  // The host mints the id so it controls the binding; the agent persists exactly that id (see /session/create).
  async open(workId: string, runKey: string, stepKey: string): Promise<string> {
    const existing = await this.works.getJobSessionId(workId, runKey, stepKey);
    if (existing) return existing;
    const record = await this.works.get(workId);
    if (!record?.workspaceId) throw new Error(`work ${workId} has no workspace for a step session`);
    const sessionId = randomUUID();
    const resolved = await this.agent.createSession(record.workspaceId, workId, undefined, sessionId);
    await this.works.addJobSession(workId, resolved, runKey, stepKey);
    return resolved;
  }

  // release one step session: close it on the agent and drop its row. Drives both the per-step "answer landed"
  // path and the sender's "dispatch never reached the agent" rollback. Idempotent — a missing row is a no-op.
  async close(sessionId: string): Promise<void> {
    await this.agent.closeSession(sessionId);
    await this.works.removeJobSession(sessionId);
  }

  // discard every live job session a work holds — the sweep behind stop/complete/fail/reset (the discard rule:
  // a run-generation change or terminal end invalidates all per-step sessions). Idempotent via the empty set.
  private async closeAllJobSessions(workId: string): Promise<void> {
    for (const sessionId of await this.works.listJobSessionIds(workId)) {
      await this.close(sessionId);
    }
  }

  // stops a work the caller owns: cut BOTH halves and NOTHING else. The engine cancel (bus -> engine) kills pending
  // Temporal steps; closing every per-step session aborts any in-flight turn NOW (via EXECUTION_CANCEL, collapsing
  // the executor subtree). Deliberately NO status write — stop only cancels; the cancel's own confirmation drives
  // the record: WORKFLOW_STOPPED settles it to `attention` (or a reconnect reconcile that finds the run `canceled`).
  // Returns the record unchanged so the route can 404 a non-owner; the next read reflects the engine fold.
  async stop(workId: string, userId: string, _reason: string): Promise<WorkRecord | null> {
    const record = await this.works.get(workId);
    if (!record || record.userId !== userId) return null;
    if (isTerminalStatus(record.status)) return record; // a `complete` work is locked — no cancel, no side effects
    if (record.temporalId) this.bus.publish(WORKFLOW_STOP, { workId, temporalId: record.temporalId });
    await this.closeAllJobSessions(workId);
    return record;
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
    if (isTerminalStatus(record.status)) return false; // locked: a `complete` work takes no injection
    if (!record.temporalId) return false;
    this.bus.publish(WORKFLOW_INJECT, { temporalId: record.temporalId, variables, ...opts });
    return record;
  }

  // operator "continue": pick a stopped work back up — re-execute its last step via engine Reset. ownership by
  // workId; only an `attention` work (the single non-terminal stopped state — clean stop or failure) is resettable
  // (a `complete` work is done and locked; the engine refuses a running one). returns null for a non-owner, false
  // when the work isn't in a recoverable state. status goes back to `running`.
  async continue(workId: string, userId: string): Promise<WorkRecord | null | false> {
    const record = await this.works.get(workId);
    if (!record || record.userId !== userId) return null;
    if (record.status !== "attention") return false;
    // reset spawns a new run (new run_key), invalidating the old run's per-step sessions — discard them up front
    await this.closeAllJobSessions(workId);
    this.bus.publish(WORKFLOW_RESET, { workId });
    return this.works.update(workId, { status: "running", step: "re-executing stopped step" });
  }

  // operator "rerun from step": re-execute a work from a chosen step via engine Reset (re-runs that step and
  // everything after, dropping old answers). ownership by workId; refused on a terminal `complete` work (locked, no
  // side effects) — every other status allows it, and the engine still refuses while the run is live. status goes
  // back to `running` as the new run boots; null for a non-owner.
  async rerunStep(workId: string, userId: string, stepId: string): Promise<WorkRecord | null> {
    const record = await this.works.get(workId);
    if (!record || record.userId !== userId) return null;
    if (isTerminalStatus(record.status)) return record; // locked — no reset
    // reset spawns a new run (new run_key), invalidating the old run's per-step sessions — discard them up front
    await this.closeAllJobSessions(workId);
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
    if (isTerminalStatus(record.status)) return record; // locked — no broker retry
    this.bus.publish(WORKFLOW_RETRY, { jobKey, ...opts });
    return record;
  }

  // terminal SUCCESS: the engine returned, so sweep any per-step sessions still open (post-workflow cleanup) and
  // settle to `complete` — the clean, locked, terminal end.
  private async complete(temporalId: string, result: unknown): Promise<void> {
    const record = await this.byTemporalId(temporalId);
    if (!record) return;
    const description = result == null ? null : String(result);
    await this.closeAllJobSessions(record.workId);
    await this.works.update(record.workId, { status: "complete", step: description });
  }

  // a failed workflow settles to `attention` (the orange, troubled-but-recoverable end), with the engine's error as
  // the row's context. Recovery is the same engine Reset (continue/rerun) as any stop — `attention` is the single
  // non-terminal stopped state. sweep the per-step sessions like any stop.
  public async markFailed(temporalId: string, error: string): Promise<void> {
    const record = await this.byTemporalId(temporalId);
    if (!record) return;
    await this.closeAllJobSessions(record.workId);
    await this.works.update(record.workId, { status: "attention", step: error });
  }

  // the cancel landed (WORKFLOW_STOPPED): THIS is the event that settles a stopped work. A live (new/running) work
  // folds to `attention` — the single non-terminal stopped state — with a NULL description (a clean stop carries no
  // message; the per-step Temporal status shows what actually happened), sweeping its sessions. An already-settled
  // work (`complete`, or `attention` from a failure that raced ahead) keeps its status and only has lingering
  // sessions cleaned. By engine id.
  private async onStopConfirmed(temporalId: string): Promise<void> {
    const record = await this.byTemporalId(temporalId);
    if (!record) return;
    if (record.status === "new" || record.status === "running") {
      await this.closeAllJobSessions(record.workId);
      await this.works.update(record.workId, { status: "attention", step: null });
      return;
    }
    await this.finalizeStop(record);
  }

  // post-stop cleanup: sweeps any per-step sessions a settled (`attention`) work still holds. Fires from the
  // WORKFLOW_STOPPED confirmation and from reconcile when the engine reports the run gone. idempotent — once the
  // sessions are gone it is a no-op. a `complete` work never reaches here (the reconcile gate excludes it).
  private async finalizeStop(record: WorkRecord): Promise<void> {
    await this.closeAllJobSessions(record.workId);
  }

  // fold a reconcile answer onto the record — the recovery net for push events the host may have missed (e.g. a
  // restart dropped the in-memory result watcher). Every non-terminal work RECALCULATES here against live engine
  // truth on each poll — the status is not latched: an `attention` work returns to `running` when its workflow is
  // active again, and a `running` work that the engine canceled/failed becomes `attention`. resolveEngineStatus is
  // the single recompute authority; `complete` is terminal and never re-evaluated.
  private async reconcile(workId: string, status: string | undefined, missing: boolean | undefined): Promise<void> {
    const record = await this.works.get(workId);
    if (!record || record.status === "complete") return;
    const resolved = resolveEngineStatus(status, missing);
    if (!resolved) return; // completed / unknown: leave to the push path
    // a brand-new work whose instance hasn't surfaced yet must not be flipped to `attention` by a transient `missing`
    if (resolved.status === "attention" && record.status === "new") return;
    // store the recalculated status; `running` keeps its live step text, an `attention` fold sets/clears its own
    if (resolved.status !== record.status) {
      if (resolved.status === "attention") await this.works.update(workId, { status: "attention", step: resolved.description });
      else await this.works.update(workId, { status: resolved.status });
    }
    // a work settled to `attention` sweeps any lingering per-step sessions (idempotent — no-op when none remain)
    if (resolved.status === "attention") await this.finalizeStop(record);
  }

  // the work unit carries the engine id as temporalId (== our workId); fold terminal events back by it
  private async byTemporalId(temporalId: string): Promise<WorkRecord | undefined> {
    return (await this.works.search()).find((r) => r.temporalId === temporalId);
  }
}
