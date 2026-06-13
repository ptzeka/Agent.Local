import { randomUUID } from "node:crypto";

/**
 * TurnRunner — the session's single-writer turn scheduler.
 *
 * Why this exists: `AgentRuntime.dispatchAsync` is single-flight, guarded by
 * `session.status === "running"`. Once more than one producer can start work
 * (the user, a settling sub-session, later an HTTP API), direct dispatch races:
 * two callers collide on the guard and one throws. The TurnRunner removes the
 * race structurally — producers never dispatch, they push prompt content to the
 * InputInbox and `wake()` the runner, and exactly ONE pump loop is ever the
 * caller of the dispatch function.
 *
 * Contentless by design. Prompt text lives in the InputInbox — the single
 * injection interface — not here. A "turn" is just one `dispatchAsync` the pump
 * drives; the dispatch DRAINS the inbox for its own input. So mid-turn steering
 * needs no scheduling: input pushed while a turn runs is drained by that turn at
 * its next iteration boundary. The runner only answers "is there work, and may I
 * run one engagement now" — `shouldRun` (inbox.hasPending) is the work predicate,
 * so a wake that the running turn already drained never spawns an empty turn.
 *
 * Single-writer is per RUNNER, not per session — one runner per session is the
 * host's contract. A distributed host must enforce it with an ownership lease.
 *
 * Architecture role: Service layer. The runner knows nothing about providers,
 * MCP, or the orchestrator — it drives an injected `TurnDispatch`, which the
 * runtime binds to `dispatchAsync`.
 */

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

/** Who woke the runner. Extend freely — the runner treats it as a tag. */
export type TurnSource = "user" | "subsession" | "api";

export type TurnStatus = "running" | "done" | "error" | "cancelled";

/**
 * The single operation the pump drives: run one engagement through the session
 * (the runtime binds this to `dispatchAsync`, which drains the inbox for input).
 * The signal aborts the turn when it is cancelled.
 */
export type TurnDispatch = (signal: AbortSignal) => Promise<{ outcome: string }>;

// ---------------------------------------------------------------------------
// Observability events
// ---------------------------------------------------------------------------

export type TurnRunnerEvent =
  | { type: "turn-start"; turnId: string; source: TurnSource }
  | { type: "turn-done"; turnId: string; source: TurnSource; status: TurnStatus };

export type TurnRunnerListener = (event: TurnRunnerEvent) => void;

export interface TurnRunnerOptions {
  /** Lifecycle listener for rendering / telemetry. Errors are swallowed. */
  onEvent?: TurnRunnerListener;
  /** Cancellation chain link: an ancestor cancel aborts a turn exactly like a
   *  per-turn cancel — "cancelled", never "error". */
  parentSignal?: AbortSignal;
  /**
   * Work predicate. The pump runs a turn only when this returns true — the
   * runtime points it at `inbox.hasPending`, so a wake whose content the
   * running turn already drained settles without spawning an empty turn. When
   * omitted, every wake runs a turn (the conservative fallback).
   */
  shouldRun?: () => boolean;
}

// ---------------------------------------------------------------------------
// TurnRunner
// ---------------------------------------------------------------------------

/** The live turn under the pump. One at a time; created on begin, cleared on
 *  settle. Holds the abort plumbing the host's stop/cancel reach through. */
interface CurrentTurn {
  turnId: string;
  source: TurnSource;
  status: TurnStatus;
  controller: AbortController;
  /** Derived signal (parent OR own controller) — the abort truth dispatch observes. */
  signal: AbortSignal;
}

export class TurnRunner {
  private current: CurrentTurn | null = null;

  /** A wake arrived and has not yet been consumed by the pump. */
  private pending = false;
  /** Source of the wake that the next turn will report. */
  private pendingSource: TurnSource = "user";

  private readonly listener?: TurnRunnerListener;
  private readonly parentSignal?: AbortSignal;
  private readonly shouldRun?: () => boolean;

  private started = false;
  private stopping = false;
  private pumpDone: Promise<void> | null = null;
  /** Resolver that un-parks the pump when it had no work. */
  private wakePump: (() => void) | null = null;
  /** Resolvers parked on awaitIdle(), flushed when the runner goes idle. */
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly dispatch: TurnDispatch, options: TurnRunnerOptions = {}) {
    this.listener = options.onEvent;
    this.parentSignal = options.parentSignal;
    this.shouldRun = options.shouldRun;
  }

  // ------------------------------------------------------------------------
  // Producer API
  // ------------------------------------------------------------------------

  /**
   * Signal that there is work (the inbox received content). Idempotent and safe
   * from any producer at any time: it records the wake and un-parks the pump.
   * If a turn is already running, the running turn will drain the new input at
   * its next iteration — the pump only starts another turn if, once that turn
   * settles, the work predicate still reports pending input (the settle-race).
   */
  public wake(source: TurnSource = "user"): void {
    this.pending = true;
    this.pendingSource = source;
    this.kickPump();
  }

  /**
   * Abort the in-flight turn. Returns false when its id is unknown/settled.
   * There is no pending-turn queue to cancel — unconsumed input lives in the
   * inbox, not here.
   */
  public cancel(turnId: string): boolean {
    if (this.current?.turnId === turnId) {
      this.current.controller.abort();
      return true;
    }
    return false;
  }

  /** Abort whatever turn is in flight — the host's "stop" affordance. */
  public cancelCurrent(): boolean {
    return this.current ? this.cancel(this.current.turnId) : false;
  }

  /** Stop everything: drop a queued wake and abort the running turn. */
  public cancelAll(): number {
    this.pending = false;
    return this.cancelCurrent() ? 1 : 0;
  }

  // ------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------

  /** Start the pump. Idempotent. */
  public start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.pumpDone = this.pump();
  }

  /** Graceful stop: the in-flight turn finishes; resolves once the pump exits. */
  public async stop(): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    this.kickPump();
    await this.pumpDone;
    this.started = false;
    this.pumpDone = null;
  }

  // ------------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------------

  /** True when a turn is in flight OR a wake is waiting to run. */
  public get isBusy(): boolean {
    return this.current !== null || this.pending;
  }

  /**
   * Resolves once nothing is in flight and no wake is pending — the bridge
   * between a synchronous cancel and operations that need true quiescence
   * (reset/compact): cancelAll() fires the abort, but the in-flight turn unwinds
   * asynchronously, and mutating state before it settles would let the dying
   * turn write into the fresh state.
   */
  public awaitIdle(): Promise<void> {
    if (!this.isBusy) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  // ------------------------------------------------------------------------
  // The pump — the ONLY caller of `dispatch`
  // ------------------------------------------------------------------------

  private async pump(): Promise<void> {
    while (!this.stopping) {
      if (!this.pending) {
        await this.parkPump();
        continue;
      }
      // Consume the wake. The predicate guards against a wake whose content the
      // turn just finished draining — without it that wake would run empty.
      this.pending = false;
      const source = this.pendingSource;
      if (this.shouldRun && !this.shouldRun()) {
        this.flushIdleWaitersIfIdle();
        continue;
      }
      await this.runTurn(source);
    }
  }

  private async runTurn(source: TurnSource): Promise<void> {
    const turn = this.beginTurn(source);
    try {
      await this.dispatch(turn.signal);
      turn.status = turn.signal.aborted ? "cancelled" : "done";
    } catch (err) {
      // A user stop must never render (or persist) as a broken turn.
      turn.status = turn.signal.aborted ? "cancelled" : "error";
      if (turn.status === "error") {
        // Surface scheduler-visible failures via the event; dispatch owns its
        // own error reporting/persistence, so nothing else to do here.
        void err;
      }
    } finally {
      this.finalizeTurn(turn);
    }
  }

  private beginTurn(source: TurnSource): CurrentTurn {
    const controller = new AbortController();
    const turn: CurrentTurn = {
      turnId: randomUUID(),
      source,
      status: "running",
      controller,
      signal: this.parentSignal
        ? AbortSignal.any([this.parentSignal, controller.signal])
        : controller.signal,
    };
    this.current = turn;
    this.emit({ type: "turn-start", turnId: turn.turnId, source: turn.source });
    return turn;
  }

  private finalizeTurn(turn: CurrentTurn): void {
    this.current = null;
    this.emit({ type: "turn-done", turnId: turn.turnId, source: turn.source, status: turn.status });
    this.flushIdleWaitersIfIdle();
  }

  private flushIdleWaitersIfIdle(): void {
    if (this.isBusy) return;
    const waiters = this.idleWaiters.splice(0);
    for (const wake of waiters) wake();
  }

  // sleep pump until next wake
  private parkPump(): Promise<void> {
    this.flushIdleWaitersIfIdle();
    return new Promise<void>((resolve) => {
      this.wakePump = resolve;
    });
  }

  // restart pump
  private kickPump(): void {
    const wake = this.wakePump;
    this.wakePump = null;
    wake?.();
  }

  private emit(event: TurnRunnerEvent): void {
    try {
      this.listener?.(event);
    } catch {
      /* a throwing listener must not break the pump */
    }
  }
}
