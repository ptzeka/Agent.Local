import { randomUUID } from "node:crypto";

// removes the multi-producer dispatch race structurally: producers only push to the inbox and wake()
// the runner, so exactly ONE pump loop ever calls dispatch; single-writer is per RUNNER, one per session
// contentless — prompt text lives in the inbox, so input pushed mid-turn is drained at the next iteration

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

// the runner treats the source purely as a tag; extend freely
export type TurnSource = "user" | "subsession" | "api";

export type TurnStatus = "running" | "done" | "error" | "cancelled";

// the runtime binds this to dispatchAsync, which drains the inbox for its own input
export type TurnDispatch = (signal: AbortSignal) => Promise<{ outcome: string }>;

// ---------------------------------------------------------------------------
// Observability events
// ---------------------------------------------------------------------------

export type TurnRunnerEvent =
  | { type: "turn-start"; turnId: string; source: TurnSource }
  | { type: "turn-done"; turnId: string; source: TurnSource; status: TurnStatus };

export type TurnRunnerListener = (event: TurnRunnerEvent) => void;

export interface TurnRunnerOptions {
  // errors are swallowed so a throwing listener can't break the pump
  onEvent?: TurnRunnerListener;
  // an ancestor cancel aborts a turn as "cancelled", never "error"
  parentSignal?: AbortSignal;
  // pointed at inbox.hasPending so a wake the running turn already drained settles without an empty turn
  shouldRun?: () => boolean;
}

// ---------------------------------------------------------------------------
// TurnRunner
// ---------------------------------------------------------------------------

// one live turn at a time, holding the abort plumbing the host's stop/cancel reach through
interface CurrentTurn {
  turnId: string;
  source: TurnSource;
  status: TurnStatus;
  controller: AbortController;
  // parent OR own controller: the abort truth dispatch observes
  signal: AbortSignal;
}

export class TurnRunner {
  private current: CurrentTurn | null = null;

  private pending = false;
  private pendingSource: TurnSource = "user";

  private readonly listener?: TurnRunnerListener;
  private readonly parentSignal?: AbortSignal;
  private readonly shouldRun?: () => boolean;

  private started = false;
  private stopping = false;
  private pumpDone: Promise<void> | null = null;
  // resolver that un-parks the pump when it had no work
  private wakePump: (() => void) | null = null;
  // resolvers parked on awaitIdle(), flushed when the runner goes idle
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly dispatch: TurnDispatch, options: TurnRunnerOptions = {}) {
    this.listener = options.onEvent;
    this.parentSignal = options.parentSignal;
    this.shouldRun = options.shouldRun;
  }

  // ------------------------------------------------------------------------
  // Producer API
  // ------------------------------------------------------------------------

  // idempotent and safe from any producer; a running turn drains new input itself, so the pump
  // only starts another turn if the work predicate still reports pending input after this one settles
  public wake(source: TurnSource = "user"): void {
    this.pending = true;
    this.pendingSource = source;
    this.kickPump();
  }

  // false when the id is unknown/settled; there is no pending-turn queue, unconsumed input lives in the inbox
  public cancel(turnId: string): boolean {
    if (this.current?.turnId === turnId) {
      this.current.controller.abort();
      return true;
    }
    return false;
  }

  // the host's "stop" affordance
  public cancelCurrent(): boolean {
    return this.current ? this.cancel(this.current.turnId) : false;
  }

  // drop a queued wake and abort the running turn
  public cancelAll(): number {
    this.pending = false;
    return this.cancelCurrent() ? 1 : 0;
  }

  // ------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------

  // idempotent
  public start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.pumpDone = this.pump();
  }

  // graceful: the in-flight turn finishes; resolves once the pump exits
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

  // queued input counts as busy so awaitIdle() (reset/compact) waits through a multi-prompt drain,
  // not just the turn in flight — otherwise it could resolve between two one-prompt-per-turn passes
  public get isBusy(): boolean {
    return this.current !== null || this.pending || this.hasQueuedInput();
  }

  private hasQueuedInput(): boolean {
    // never self-perpetuate a stillborn turn: once the parent has aborted, a queued prompt can never
    // dispatch (the turn dies on its own abort check before draining), so re-arming off it would spin
    if (this.parentSignal?.aborted) return false;
    return this.shouldRun ? this.shouldRun() : false;
  }

  // reset/compact need true quiescence: cancelAll() aborts, but the turn unwinds async, and
  // mutating state before it settles would let the dying turn write into the fresh state
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
      // one prompt per turn: a discrete wake OR input still queued keeps the pump running, so it
      // self-perpetuates through a multi-prompt inbox instead of parking after the first turn
      if (!this.pending && !this.hasQueuedInput()) {
        await this.parkPump();
        continue;
      }
      // the predicate guards against a wake whose content the turn just finished draining
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
      // a user stop must never render or persist as a broken turn
      turn.status = turn.signal.aborted ? "cancelled" : "error";
      if (turn.status === "error") {
        // dispatch owns its own error reporting/persistence, so the event is all that's left here
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
      // a throwing listener must not break the pump
    }
  }
}
