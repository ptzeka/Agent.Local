import { randomUUID } from "node:crypto";

import { foldDelegatedUsage, type Session } from "./session.js";
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

// intentionally small while sub-sessions are new; configurable via the constructor
const DEFAULT_MAX_ACTIVE_PER_PARENT = 4;

// backoff from the 2nd identical status, doubling and capped, so a tight get_status loop stops burning budget
const POLL_BACKOFF_BASE_MS = 1000;
const POLL_BACKOFF_MAX_MS = 15000;

// owns the orchestrator's sub-sessions in an in-memory parent→sub map; the child's transcript is persisted by its own runtime
// create() builds each child its own runtime, detaches one dispatch of the intent, and returns a running snapshot at once
// a child's coordinator is capped at 0, so a sub-session can't spawn sub-sessions — the one-level-deep guard
export class SessionManager implements SubSessionCoordinator {
  private readonly active = new Map<string, Map<string, SubSession>>();
  // kept after archival so getStatus can still answer
  private readonly archived = new Map<string, Map<string, SubSession>>();
  private readonly notificationListeners = new Set<SubSessionNotificationListener>();

  constructor(
    // undefined on a leaf coordinator (cap 0), which never spawns and so never calls it
    private readonly subRuntimeFactory: SubRuntimeFactory | undefined,
    private readonly maxActivePerParent: number = DEFAULT_MAX_ACTIVE_PER_PARENT,
    // settled children fold their tally into these counters in memory; the parent's next persist writes the sum
    private readonly parentSession?: Session,
    // children derive from this so an ancestor cancel reaches them without this manager being told
    private readonly parentSignal?: AbortSignal
  ) {}

  // push seam so a finished child reports itself instead of being polled; in-memory, lost on restart
  public onNotification(listener: SubSessionNotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  public createSubSession(params: CreateSubSessionParams): CreateSubSessionResult {
    const siblings = this.active.get(params.parentSessionId);

    // dedupe a still-running identical intent so a runaway respawn loop can't burn the cap; completed dupes are freed below
    const wanted = normalizeIntent(params.intent);
    let reusableRunning: SubSession | undefined;
    const toFinalize: SubSession[] = [];

    if (siblings) {
      for (const sib of siblings.values()) {
        if (normalizeIntent(sib.intent) === wanted) {
          if (sib.status === "running") {
            reusableRunning = sib;
          } else if (sib.status !== "archived") {
            toFinalize.push(sib);
          }
        }
      }
    }

    if (reusableRunning) {
      return {
        outcome: "reused",
        snapshot: toSnapshot(reusableRunning),
        reason: `an active sub-session with this intent already exists (${reusableRunning.subSessionId}, status=${reusableRunning.status})`,
      };
    }

    // free slots held by completed dupes; collected first so this doesn't mutate during iteration
    for (const sub of toFinalize) {
      this.finalize(params.parentSessionId, sub.subSessionId);
    }

    // refuse beyond the per-parent ceiling so the model waits on / finalizes existing children first
    const activeCount = siblings?.size ?? 0;
    if (activeCount >= this.maxActivePerParent) {
      return {
        outcome: "rejected",
        snapshot: null,
        reason: `sub-session cap of ${this.maxActivePerParent} active children reached; finalize one before spawning another`,
      };
    }

    const subSessionId = randomUUID();

    // created synchronously so the tool reply carries a running snapshot; the child's sessionId IS the subSessionId
    const sub = makeSubSession({
      subSessionId,
      parentSessionId: params.parentSessionId,
      intent: params.intent,
      parentSignal: this.parentSignal,
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

    if (sub.lastPolledStatus === sub.status) {
      sub.pollRepeat += 1;
    } else {
      sub.lastPolledStatus = sub.status;
      sub.pollRepeat = 1;
    }

    // abortable backoff from the 2nd identical status so finalize / Ctrl-C never hangs on a sleeping poll
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
      // idempotent: hand back the archived snapshot rather than erroring on a double-call
      const prior = this.archived.get(parentSessionId)?.get(subSessionId);
      return prior ? toSnapshot(prior) : null;
    }

    // cancel before archiving; the detached promise's settle() guard then sees not-running and won't clobber
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

  // "stop everything": goes through finalize() so each settle guard suppresses the report-back a stop must not enqueue
  public cancelActive(parentSessionId: string): number {
    const snapshots = this.list(parentSessionId);
    for (const snapshot of snapshots) {
      this.finalize(parentSessionId, snapshot.subSessionId, "error");
    }
    return snapshots.length;
  }

  // powers the list_subsessions diagnostic tool
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

  // fire-and-forget: build+run fold into the detached promise so createSubSession stays synchronous for the tool reply
  private launch(sub: SubSession, params: CreateSubSessionParams): void {
    // retained so a caller can block on completion; both arms resolve, so awaiting it never rejects
    sub.settled = this.run(sub, params)
      .then((result) => {
        return this.settle(sub, () => {
          // record a capped run as error so "didn't finish" means the same here as for a top-level run
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

  // attaches the live runtime + session to the record (for status reads and future steering) before dispatching
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
      // finalize, shutdown, and the CLI root all reach the child's resources through this one signal
      parentSignal: sub.signal,
    }).build();

    sub.runtime = runtime;
    sub.session = runtime.getSession();

    return runtime.dispatchAsync(sub.intent, { signal: sub.signal });
  }

  // headless single run drains its children before exit; one pass suffices because children are one level deep
  // and the parent's run already returned, so no new children appear and each settled promise is enough to await
  public async awaitActive(parentSessionId: string): Promise<void> {
    const map = this.active.get(parentSessionId);
    if (!map) return;
    const pending = [...map.values()].map((sub) => sub.settled ?? Promise.resolve());
    await Promise.all(pending);
  }

  // process teardown joins the children the REPL fired and forgot; one pass suffices for the same reason as awaitActive
  public async awaitAllActive(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const map of this.active.values()) {
      for (const sub of map.values()) {
        pending.push(sub.settled ?? Promise.resolve());
      }
    }
    await Promise.all(pending);
  }

  // guard so a run rejection from an already-finalized child can't flip "archived" back to "error"
  // a genuine settle also persists the outcome and notifies — what makes a finished child durable and pollless
  private async settle(sub: SubSession, mutate: () => void): Promise<void> {
    if (sub.status !== "running") return;
    mutate();
    sub.updatedAt = Date.now();

    // cast re-widens status: the guard narrowed it to "running" and TS can't see mutate() moved it terminal
    const settledStatus = sub.status as SubSessionStatus;
    if (settledStatus === "done" || settledStatus === "error") {
      // folded here, not on a tool result, because a detached child settles after the parent's turn returned
      if (this.parentSession && sub.session) {
        foldDelegatedUsage(this.parentSession.counters, sub.session.counters);
      }
      // a run that errored before its runtime came up has nothing to persist, but still notifies the failed spawn
      if (sub.runtime && sub.session) {
        sub.session.status = settledStatus;
        sub.session.counters.turns = Math.max(sub.session.counters.turns, 1);
        sub.session.updatedAt = sub.updatedAt;
        await sub.runtime.finalize().catch(() => {
          // best-effort: a child that fails to persist still notifies
        });
      }
      this.emitNotification(sub);
    }
  }

  // listener errors are isolated so one bad subscriber can't starve the others
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
        // a throwing subscriber must not break the settle path
      }
    }
  }
}

// tolerant enough to catch the model re-asking for the same thing with cosmetic differences
function normalizeIntent(intent: string): string {
  return intent.trim().toLowerCase().replace(/\s+/g, " ");
}

// resolves after ms, or immediately when signal aborts
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
