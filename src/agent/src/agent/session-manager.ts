import { randomUUID } from "node:crypto";

import type { InputInbox } from "./input-inbox.js";
import type { SessionRunner } from "./orchestrator.js";
import { createSession } from "./session.js";
import {
  makeSubSession,
  toSnapshot,
  type CreateSubSessionParams,
  type CreateSubSessionResult,
  type StatusResult,
  type SubSession,
  type SubSessionCoordinator,
  type SubSessionSnapshot,
} from "./subsession.js";

/** Default ceiling on concurrently-active children per parent. Configurable via
 *  the constructor; intentionally small while sub-sessions are new. */
const DEFAULT_MAX_ACTIVE_PER_PARENT = 2;

/** Poll backoff: delay applied the 2nd time the same status comes back, doubling
 *  each further repeat, capped. Throttles a tight get_status loop in wall-clock
 *  time so it stops burning iterations and API budget. */
const POLL_BACKOFF_BASE_MS = 1000;
const POLL_BACKOFF_MAX_MS = 15000;

/**
 * SessionManager — Service layer. Owns the orchestrator's sub-sessions.
 *
 * Sub-sessions are held in memory exactly as the two-level map the design
 * calls for: parentSessionId → (subSessionId → SubSession). Nothing is
 * persisted — sub-sessions are transient, in-flight work, not durable state.
 *
 * `create` spawns a DETACHED orchestrator run for the intent and returns
 * immediately with a `running` snapshot; the parent polls via `getStatus` and
 * ends a child with `finalize`. The run is launched through the injected
 * `SessionRunner` (the orchestrator) WITHOUT a coordinator in its options, so a
 * sub-session cannot itself spawn sub-sessions — a deliberate one-level guard.
 */
export class SessionManager implements SubSessionCoordinator {
  /** Active children, keyed parent → sub. */
  private readonly active = new Map<string, Map<string, SubSession>>();
  /** Finalized children, kept so getStatus can still answer after archival. */
  private readonly archived = new Map<string, Map<string, SubSession>>();

  constructor(
    private readonly runner: SessionRunner,
    private readonly inbox: InputInbox,
    private readonly maxActivePerParent: number = DEFAULT_MAX_ACTIVE_PER_PARENT
  ) {}

  public createSubSession(params: CreateSubSessionParams): CreateSubSessionResult {
    const siblings = this.active.get(params.parentSessionId);

    // Dedupe: an identical outstanding intent is reused, never duplicated. This
    // also stops a runaway "spawn the same child again" loop from burning the
    // cap or piling on redundant API load.
    const wanted = normalizeIntent(params.intent);
    if (siblings) {
      for (const sib of siblings.values()) {
        if (normalizeIntent(sib.intent) === wanted) {
          return {
            outcome: "reused",
            snapshot: toSnapshot(sib),
            reason: `an active sub-session with this intent already exists (${sib.subSessionId}, status=${sib.status})`,
          };
        }
      }
    }

    // Cap: refuse to fan out beyond the per-parent ceiling. The orchestrator
    // surfaces this so the model waits on / finalizes existing children first.
    const activeCount = siblings?.size ?? 0;
    if (activeCount >= this.maxActivePerParent) {
      return {
        outcome: "rejected",
        snapshot: null,
        reason: `sub-session cap of ${this.maxActivePerParent} active children reached; finalize one before spawning another`,
      };
    }

    const subSessionId = randomUUID();

    // The child shares its parent's workspace segment; its own sessionId IS the
    // subSessionId, so the inbox key and the run's session identity coincide.
    const session = createSession({
      sessionId: subSessionId,
      workspaceId: params.workspace.workspaceId,
      parentSessionId: params.parentSessionId,
    });

    if (params.context && params.context.trim().length > 0) {
      session.conversation.push({
        role: "system",
        content: `Sub-session standing context:\n\n${params.context.trim()}`,
      });
    }

    const sub = makeSubSession({
      subSessionId,
      parentSessionId: params.parentSessionId,
      intent: params.intent,
      session,
    });

    this.track(sub);
    this.launch(sub, params);

    return { outcome: "created", snapshot: toSnapshot(sub) };
  }

  public async getStatus(
    parentSessionId: string,
    subSessionId: string,
    signal?: AbortSignal
  ): Promise<StatusResult | null> {
    const sub =
      this.active.get(parentSessionId)?.get(subSessionId) ??
      this.archived.get(parentSessionId)?.get(subSessionId);
    if (!sub) return null;

    // Track consecutive identical statuses across polls.
    if (sub.lastPolledStatus === sub.status) {
      sub.pollRepeat += 1;
    } else {
      sub.lastPolledStatus = sub.status;
      sub.pollRepeat = 1;
    }

    // From the 2nd identical status on, back off exponentially before answering
    // (1s, 2s, 4s, … capped). The delay is abortable so finalize / Ctrl-C never
    // hangs on a sleeping poll.
    let backoffMs = 0;
    if (sub.pollRepeat >= 2) {
      const steps = sub.pollRepeat - 1;
      backoffMs = Math.min(POLL_BACKOFF_BASE_MS * 2 ** (steps - 1), POLL_BACKOFF_MAX_MS);
      await sleep(backoffMs, signal);
    }

    return { snapshot: toSnapshot(sub), backoffMs };
  }

  public finalize(
    parentSessionId: string,
    subSessionId: string,
    finalStatus?: "done" | "error"
  ): SubSessionSnapshot | null {
    const map = this.active.get(parentSessionId);
    const sub = map?.get(subSessionId);
    if (!sub || !map) {
      // Already finalized? Hand back the archived snapshot so finalize is
      // idempotent rather than erroring on a double-call.
      const prior = this.archived.get(parentSessionId)?.get(subSessionId);
      return prior ? toSnapshot(prior) : null;
    }

    // Cancel an in-flight run before archiving. The detached promise's
    // settle() guard sees status !== "running" afterward and won't clobber.
    if (sub.status === "running") {
      sub.abort.abort();
      if (finalStatus === "error" && sub.error === undefined) {
        sub.error = "finalized as error before the run completed";
      } else if (finalStatus === "done" && sub.result === undefined) {
        sub.result = "(finalized before the run completed)";
      }
    }

    sub.status = "archived";
    sub.updatedAt = Date.now();

    map.delete(subSessionId);
    if (map.size === 0) this.active.delete(parentSessionId);
    this.stash(this.archived, sub);

    return toSnapshot(sub);
  }

  /** Snapshots of every active (non-archived) child of a parent — powers the
   *  list_subsessions diagnostic tool. */
  public list(parentSessionId: string): SubSessionSnapshot[] {
    const map = this.active.get(parentSessionId);
    if (!map) return [];
    return [...map.values()].map(toSnapshot);
  }

  // --------------------------------------------------------------------------

  private track(sub: SubSession): void {
    this.stash(this.active, sub);
  }

  private stash(into: Map<string, Map<string, SubSession>>, sub: SubSession): void {
    const map = into.get(sub.parentSessionId);
    if (map) {
      map.set(sub.subSessionId, sub);
    } else {
      into.set(sub.parentSessionId, new Map([[sub.subSessionId, sub]]));
    }
  }

  /**
   * Fire-and-forget the orchestrator run that drives the intent to resolution.
   * The run loops internally until the evaluator is SATISFIED (or it caps out);
   * we just record the outcome when the promise settles. Drains the shared
   * inbox under the child's id each iteration, so a running sub-session stays
   * steerable through the same injection seam as the top-level session.
   */
  private launch(sub: SubSession, params: CreateSubSessionParams): void {
    this.runner
      .run(sub.session, params.workspace, sub.intent, {
        signal: sub.abort.signal,
        pullInjectedPrompts: () => this.inbox.drain(sub.subSessionId),
      })
      .then((result) => {
        this.settle(sub, () => {
          sub.status = "done";
          sub.result = result.finalMessage.content;
          sub.iterations = result.iterations;
          sub.dispatches = result.dispatches;
        });
      })
      .catch((err: unknown) => {
        this.settle(sub, () => {
          sub.status = "error";
          sub.error = err instanceof Error ? err.message : String(err);
        });
      });
  }

  /**
   * Apply a terminal mutation only if the sub-session is still running. Guards
   * against a finalize() that already aborted-and-archived the child: the
   * resulting run rejection must not flip "archived" back to "error".
   */
  private settle(sub: SubSession, mutate: () => void): void {
    if (sub.status !== "running") return;
    mutate();
    sub.updatedAt = Date.now();
  }
}

/** Canonical form for intent-equality: trimmed, lower-cased, whitespace
 *  collapsed. Cheap and tolerant enough to catch the model re-asking for the
 *  same thing with cosmetic differences. */
function normalizeIntent(intent: string): string {
  return intent.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Resolve after `ms`, or immediately when `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}
