import type { Session } from "./session.js";
import type { Workspace } from "./workspace-registry.js";

/**
 * Sub-session — an autonomous child run spawned by the orchestrator.
 *
 * Unlike a top-level Session (which waits for a user prompt between turns), a
 * sub-session is handed a single `intent` and driven by the orchestrator loop
 * until the evaluator reports the intent SATISFIED (or the iteration cap trips).
 * It reuses the exact same per-action + completion evaluator the interactive
 * path uses — the `intent` simply plays the role the user's prompt normally
 * plays.
 *
 * Sub-sessions live in memory only (see SessionManager). The live `session`
 * and `abort` controller are kept on the internal record; the orchestrator's
 * LLM only ever sees the derived `SubSessionSnapshot`.
 */

export type SubSessionStatus =
  | "running" // the detached orchestrator run is in flight
  | "done" // run completed (evaluator satisfied, or capped out)
  | "error" // the run threw
  | "archived"; // finalized and dereferenced from the active set

export interface SubSession {
  subSessionId: string;
  parentSessionId: string;
  /** The goal this sub-session was spawned to resolve. */
  intent: string;
  status: SubSessionStatus;
  /** The live conversational state the detached run mutates. */
  session: Session;
  /** Final assistant message content once the run completes. */
  result?: string;
  /** Failure detail when status is "error". */
  error?: string;
  /** Orchestrator iterations the run consumed (populated on completion). */
  iterations?: number;
  /** Executor dispatches the run made (populated on completion). */
  dispatches?: number;
  /** Cancels the detached run; fired by finalize() on a still-running child. */
  abort: AbortController;
  /** Status returned to the most recent get_status poll — drives poll backoff. */
  lastPolledStatus?: SubSessionStatus;
  /** Count of consecutive polls that saw `lastPolledStatus` unchanged. */
  pollRepeat: number;
  /** Epoch millis. */
  createdAt: number;
  /** Epoch millis; bumped on every status change. */
  updatedAt: number;
}

/**
 * Serializable view of a sub-session — the shape returned to the orchestrator
 * LLM as a tool result. Deliberately omits the live `session` and the abort
 * controller, which are runtime-only.
 */
export interface SubSessionSnapshot {
  subSessionId: string;
  parentSessionId: string;
  intent: string;
  status: SubSessionStatus;
  result?: string;
  error?: string;
  iterations?: number;
  dispatches?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Result of a get_status poll: the snapshot plus how long the coordinator
 * backed off before returning. `backoffMs > 0` means the SAME status has been
 * polled repeatedly and the call was deliberately slowed to curb a tight
 * polling loop.
 */
export interface StatusResult {
  snapshot: SubSessionSnapshot;
  backoffMs: number;
}

export interface CreateSubSessionParams {
  parentSessionId: string;
  /** Workspace the child shares with its parent (same sandbox segment). */
  workspace: Workspace;
  intent: string;
  /** Optional standing context seeded as a system message before the intent. */
  context?: string;
}

/**
 * Outcome of a createSubSession call. Creation is GUARDED: an identical
 * outstanding intent is reused rather than duplicated, and a per-parent cap
 * refuses further spawns. The orchestrator turns each outcome into a distinct
 * tool reply so the LLM can react (reuse the id it got back, or stop spawning).
 */
export interface CreateSubSessionResult {
  outcome: "created" | "reused" | "rejected";
  /** The new (created) or matching (reused) child; null when rejected. */
  snapshot: SubSessionSnapshot | null;
  /** Human-readable explanation for reused / rejected outcomes. */
  reason?: string;
}

/**
 * Contract the orchestrator depends on to manage sub-sessions. Implemented by
 * SessionManager; declared here (next to the data shapes) so the orchestrator
 * imports only this interface and never the concrete service — keeping the
 * orchestrator → manager → orchestrator construction acyclic.
 */
export interface SubSessionCoordinator {
  createSubSession(params: CreateSubSessionParams): CreateSubSessionResult;
  /**
   * Snapshot a child. Async because it applies an (abortable) backoff delay
   * when the same status is polled repeatedly. Returns null for an unknown id.
   */
  getStatus(
    parentSessionId: string,
    subSessionId: string,
    signal?: AbortSignal
  ): Promise<StatusResult | null>;
  /** Active (non-archived) children of a parent — powers list_subsessions. */
  list(parentSessionId: string): SubSessionSnapshot[];
  finalize(
    parentSessionId: string,
    subSessionId: string,
    finalStatus?: "done" | "error"
  ): SubSessionSnapshot | null;
}

/**
 * Build a fresh sub-session record in the `running` state. Pure but for the
 * AbortController construction; id minting and the detached run launch are the
 * SessionManager's job, mirroring how createSession leaves persistence to the
 * Initializer.
 */
export function makeSubSession(params: {
  subSessionId: string;
  parentSessionId: string;
  intent: string;
  session: Session;
}): SubSession {
  const now = Date.now();
  return {
    subSessionId: params.subSessionId,
    parentSessionId: params.parentSessionId,
    intent: params.intent,
    status: "running",
    session: params.session,
    abort: new AbortController(),
    pollRepeat: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** Project the internal record down to the LLM-facing snapshot. */
export function toSnapshot(sub: SubSession): SubSessionSnapshot {
  return {
    subSessionId: sub.subSessionId,
    parentSessionId: sub.parentSessionId,
    intent: sub.intent,
    status: sub.status,
    result: sub.result,
    error: sub.error,
    iterations: sub.iterations,
    dispatches: sub.dispatches,
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
  };
}
