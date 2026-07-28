import type { Principal } from "../identity/types.js";
import type { RunResult } from "./turn-loop.js";
import type { Session, UsageTotals } from "../session/session.js";
import type { Workspace } from "../registries/workspace-registry.js";

// autonomous child run driven by the orchestrator loop until its intent is SATISFIED, with the
// intent playing the role a user prompt normally plays; in-memory only, LLM sees only the snapshot
export type SubSessionStatus =
  | "running" // the detached orchestrator run is in flight
  | "done" // run completed (evaluator satisfied, or capped out)
  | "error" // the run threw
  | "archived"; // finalized and dereferenced from the active set

export interface SubSession {
  subSessionId: string;
  parentSessionId: string;
  intent: string;
  status: SubSessionStatus;
  // absent in the brief window between the synchronous create call and the child runtime coming up
  session?: Session;
  runtime?: ChildRuntime;
  result?: string;
  error?: string;
  iterations?: number;
  dispatches?: number;
  // fired by finalize() to cancel a still-running child
  abort: AbortController;
  // parent chain OR abort, so an ancestor cancel reaches the child without the manager enumerating it
  signal: AbortSignal;
  // never rejects (launch() handles both arms); a headless single run awaits it so no sub-task leaks on exit
  settled?: Promise<void>;
  // last polled status + repeat count drive get_status backoff against tight polling loops
  lastPolledStatus?: SubSessionStatus;
  pollRepeat: number;
  createdAt: number;
  updatedAt: number;
}

// LLM-facing tool-result view; omits the live session and abort controller, which are runtime-only
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

// backoffMs > 0 means the same status was polled repeatedly and the call was deliberately slowed
export interface StatusResult {
  snapshot: SubSessionSnapshot;
  backoffMs: number;
}

// report-back seam that replaces polling: the parent ends its turn and is told the outcome here on settle
export interface SubSessionNotification {
  subSessionId: string;
  parentSessionId: string;
  intent: string;
  // terminal only; "running" is never notified
  status: "done" | "error";
  result?: string;
  error?: string;
}

export type SubSessionNotificationListener = (notification: SubSessionNotification) => void;

export interface CreateSubSessionParams {
  parentSessionId: string;
  // child shares the parent's sandbox segment
  workspace: Workspace;
  intent: string;
  // seeded as a system message before the intent
  context?: string;
  // inherited from the parent, stamped onto the child session
  user?: Principal;
}

// coordinator mints sessionId up front so it can answer synchronously; the factory feeds these into the child pipeline
export interface SubRuntimeRefs {
  sessionId: string;
  parentSessionId: string;
  workspaceId: string;
  user?: Principal;
  standingContext?: string;
  // cancellation link: the child dies with the sub-session, the parent runtime, or the process root
  parentSignal?: AbortSignal;
}

// declared here, not imported from the runtime layer, so SessionManager depends only on this contract (no import inversion)
export interface ChildRuntime {
  build(): Promise<ChildRuntime>;
  getSession(): Session;
  // the child's cumulative token tally, folded into the parent's MetricsRegistry when it settles;
  // returns plain data (not the registry) so this contract stays free of runtime-layer types
  metricsTotals(): Readonly<UsageTotals>;
  dispatchAsync(input: string, options?: { signal?: AbortSignal }): Promise<RunResult>;
  injectInput(content: string, source?: string): void;
  awaitAllSubSessions(): Promise<void>;
  // persist to stamp the child's terminal done/error status
  finalize(): Promise<void>;
}

// composes (but does not build) a child sub-runtime for the given refs
export type SubRuntimeFactory = (refs: SubRuntimeRefs) => ChildRuntime;

// creation is GUARDED: an identical outstanding intent is reused, and a per-parent cap refuses further spawns
export interface CreateSubSessionResult {
  outcome: "created" | "reused" | "rejected";
  // null when rejected
  snapshot: SubSessionSnapshot | null;
  reason?: string;
}

// declared next to the data shapes so the orchestrator imports only this, keeping orchestrator↔manager construction acyclic
export interface SubSessionCoordinator {
  createSubSession(params: CreateSubSessionParams): CreateSubSessionResult;
  // async because it applies an abortable backoff when the same status is polled repeatedly; null for an unknown id
  getStatus(
    parentSessionId: string,
    subSessionId: string,
    signal?: AbortSignal
  ): Promise<StatusResult | null>;
  // active (non-archived) children of a parent; powers list_subsessions
  list(parentSessionId: string): SubSessionSnapshot[];
  finalize(
    parentSessionId: string,
    subSessionId: string,
    finalStatus?: "done" | "error"
  ): SubSessionSnapshot | null;
}

// pure but for the AbortController; id minting and run launch stay with SessionManager, like createSession→Initializer
export function makeSubSession(params: {
  subSessionId: string;
  parentSessionId: string;
  intent: string;
  // ancestor chain (owning runtime's scope); omitted, abort stands alone
  parentSignal?: AbortSignal;
}): SubSession {
  const now = Date.now();
  const abort = new AbortController();
  return {
    subSessionId: params.subSessionId,
    parentSessionId: params.parentSessionId,
    intent: params.intent,
    status: "running",
    abort,
    signal: params.parentSignal
      ? AbortSignal.any([params.parentSignal, abort.signal])
      : abort.signal,
    pollRepeat: 0,
    createdAt: now,
    updatedAt: now,
  };
}

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
