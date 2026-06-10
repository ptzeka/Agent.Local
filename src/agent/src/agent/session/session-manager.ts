import { randomUUID } from "node:crypto";

import {
  makeSubSession,
  toSnapshot,
  type CreateSubSessionParams,
  type CreateSubSessionResult,
  type StatusResult,
  type SubRuntimeFactory,
  type SubSession,
  type SubSessionCoordinator,
  type SubSessionNotification,
  type SubSessionNotificationListener,
  type SubSessionSnapshot,
  type SubSessionStatus,
} from "../runners/subsession.js";

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
 * Sits as a sibling of the top-level session map under the Initializer, NOT
 * above it: the Initializer owns top-level sessions directly and owns this
 * manager separately. See the ownership tree on the `Initializer` class.
 *
 * The in-memory two-level map (parentSessionId → subSessionId → SubSession) is
 * the live tracking state; the child's transcript is persisted by its own
 * runtime, so the manager itself holds no durable state.
 *
 * `create` builds the child its OWN runtime through the injected
 * `subRuntimeFactory` (the sub-pipeline, with parent-fed steps), then DETACHES a
 * single dispatch of the intent — the headless lifecycle — and returns
 * immediately with a `running` snapshot. The parent polls via `getStatus` and
 * ends a child with `finalize`. The child's own coordinator is capped at 0, so a
 * sub-session cannot itself spawn sub-sessions — the one-level-deep guard.
 */
export class SessionManager implements SubSessionCoordinator {
  /** Active children, keyed parent → sub. */
  private readonly active = new Map<string, Map<string, SubSession>>();
  /** Finalized children, kept so getStatus can still answer after archival. */
  private readonly archived = new Map<string, Map<string, SubSession>>();
  /** Report-back subscribers, notified when a child settles (done/error). */
  private readonly notificationListeners = new Set<SubSessionNotificationListener>();

  constructor(
    /** Builds a fresh child runtime per spawn — the sub-pipeline composed with
     *  parent-fed steps. Undefined on a leaf coordinator (cap 0), which never
     *  spawns and so never calls it. */
    private readonly subRuntimeFactory: SubRuntimeFactory | undefined,
    private readonly maxActivePerParent: number = DEFAULT_MAX_ACTIVE_PER_PARENT
  ) {}

  /**
   * Subscribe to child completions. The returned function unsubscribes. This is
   * the push seam the UI (and, later, an external transport) listens on so a
   * finished child reports itself instead of being polled. In-memory only —
   * subscriptions do not survive a restart.
   */
  public onNotification(listener: SubSessionNotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

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

    // The record is created synchronously (so the tool reply carries a running
    // snapshot immediately), but the child's Session is owned by its runtime and
    // attached once launch() builds it. The child's sessionId IS the
    // subSessionId, so the inbox key and the run's session identity coincide.
    const sub = makeSubSession({
      subSessionId,
      parentSessionId: params.parentSessionId,
      intent: params.intent,
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
   * Fire-and-forget the child's own one-shot runtime. Each sub-session is built
   * through the sub-pipeline (giving it a UNIQUE orchestrator/runner, inherited
   * user, and its own contextHash), then driven by a single dispatch of the
   * intent — the headless lifecycle. The build + run are folded into the
   * detached promise so createSubSession stays synchronous for the tool reply.
   *
   * The child runtime owns its inbox; future parent-driven steering injects into
   * `sub.runtime` rather than through a shared inbox.
   */
  private launch(sub: SubSession, params: CreateSubSessionParams): void {
    // Retain the settle promise on the record so a caller can block on this
    // child's completion (the headless single run drains all children before
    // exiting). Both arms resolve, so it never rejects — awaiting it is safe.
    sub.settled = this.run(sub, params)
      .then((result) => {
        return this.settle(sub, () => {
          // A capped run gave up without a satisfied verdict — record it as an
          // error so "didn't finish" means the same thing here as it does for a
          // top-level run, rather than masquerading as a clean "done".
          if (result.outcome === "capped") {
            sub.status = "error";
            sub.error = "sub-session hit the orchestrator iteration cap without completing";
          } else {
            sub.status = "done";
            sub.result = result.finalMessage.content;
          }
          sub.iterations = result.iterations;
          sub.dispatches = result.dispatches;
        });
      })
      .catch((err: unknown) => {
        return this.settle(sub, () => {
          sub.status = "error";
          sub.error = err instanceof Error ? err.message : String(err);
        });
      });
  }

  /**
   * Build the child runtime from the injected factory and run its single turn.
   * Attaches the live runtime + session to the record (for status reads and
   * future steering) before dispatching.
   */
  private async run(sub: SubSession, params: CreateSubSessionParams) {
    if (!this.subRuntimeFactory) {
      throw new Error("SessionManager: no subRuntimeFactory configured; cannot launch a sub-session.");
    }

    const runtime = await this.subRuntimeFactory({
      sessionId: sub.subSessionId,
      parentSessionId: params.parentSessionId,
      workspaceId: params.workspace.workspaceId,
      user: params.user,
      standingContext: params.context,
    }).build();

    sub.runtime = runtime;
    sub.session = runtime.getSession();

    return runtime.dispatchAsync(sub.intent, { signal: sub.abort.signal });
  }

  /**
   * Block until every active child of `parentSessionId` has settled. The
   * interactive path never calls this — children there report back through the
   * notification channel after the parent's turn ends. A headless single run
   * does: it must leave no detached sub-task in flight when the process exits.
   *
   * One pass is complete because sub-sessions are one level deep (a child
   * runtime's coordinator is capped at 0, so it cannot spawn grandchildren) and
   * the parent's own run has already returned by the time this is called, so no
   * new children will appear. settle() leaves a finished child in the active set
   * with a terminal status, so awaiting each child's `settled` promise suffices.
   */
  public async awaitActive(parentSessionId: string): Promise<void> {
    const map = this.active.get(parentSessionId);
    if (!map) return;
    const pending = [...map.values()].map((sub) => sub.settled ?? Promise.resolve());
    await Promise.all(pending);
  }

  /**
   * Block until every active child across ALL parents has settled. The shared
   * process teardown calls this on a normal exit so no detached sub-task is
   * abandoned: the REPL fires children and forgets them across turns, but on the
   * way out we join them. One pass suffices for the same reason awaitActive's
   * does — by teardown the REPL loop has stopped and any headless run has
   * returned, so no new children can appear, and settle() leaves a finished
   * child in the active set with a terminal status (its `settled` already
   * resolved).
   */
  public async awaitAllActive(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const map of this.active.values()) {
      for (const sub of map.values()) {
        pending.push(sub.settled ?? Promise.resolve());
      }
    }
    await Promise.all(pending);
  }

  /**
   * Apply a terminal mutation only if the sub-session is still running. Guards
   * against a finalize() that already aborted-and-archived the child: the
   * resulting run rejection must not flip "archived" back to "error".
   *
   * On a genuine settle it also mirrors the outcome onto the persisted child
   * session, writes it, and fires the report-back notification — the two
   * effects that make a finished child both durable and visible without a poll.
   */
  private async settle(sub: SubSession, mutate: () => void): Promise<void> {
    if (sub.status !== "running") return;
    mutate();
    sub.updatedAt = Date.now();

    // Mirror the sub-session outcome onto the underlying Session so the
    // persisted file records a terminal status alongside the full transcript
    // the orchestrator mutated in place. The cast re-widens `status`: the guard
    // above narrowed it to "running", and TS can't see that the opaque mutate()
    // just moved it to a terminal state.
    const settledStatus = sub.status as SubSessionStatus;
    if (settledStatus === "done" || settledStatus === "error") {
      // The child's runtime owns persistence; stamp the terminal sub-session
      // status onto its session and let it write. A run that errored before the
      // runtime came up has neither — there is nothing to persist, but we still
      // notify so the parent learns the spawn failed.
      if (sub.runtime && sub.session) {
        sub.session.status = settledStatus;
        sub.session.counters.turns = Math.max(sub.session.counters.turns, 1);
        sub.session.updatedAt = sub.updatedAt;
        await sub.runtime.finalize().catch(() => {
          /* best-effort: a child that fails to persist still notifies */
        });
      }
      this.emitNotification(sub);
    }
  }

  /** Notify every subscriber that a child reached a terminal state. Listener
   *  errors are isolated so one bad subscriber can't starve the others. */
  private emitNotification(sub: SubSession): void {
    if (sub.status !== "done" && sub.status !== "error") return;
    const notification: SubSessionNotification = {
      subSessionId: sub.subSessionId,
      parentSessionId: sub.parentSessionId,
      intent: sub.intent,
      status: sub.status,
      result: sub.result,
      error: sub.error,
    };
    for (const listener of this.notificationListeners) {
      try {
        listener(notification);
      } catch {
        /* a throwing subscriber must not break the settle path */
      }
    }
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
