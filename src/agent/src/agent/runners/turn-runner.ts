import { randomUUID } from "node:crypto";

/**
 * TurnRunner — the session's single-writer turn scheduler.
 *
 * Execution hierarchy (coarse → fine):
 *
 *   TurnRunner queue            FIFO of TURNs; ONE pump consumes it
 *     └─ TURN                   one queued engagement (a user request, a
 *        │                      sub-session report, a future API call)
 *        └─ ROUND               one orchestrator dispatch within the turn
 *           └─ iterations       the orchestrator's internal loop (not ours)
 *
 * Why this exists: `AgentRuntime.dispatchAsync` is a single-flight operation
 * guarded by `session.status === "running"`. Once more than one producer can
 * start work (the user, a settling sub-session, later an HTTP API), direct
 * dispatch becomes a race: two callers collide on the guard and one throws.
 * The TurnRunner removes the race structurally — every producer ENQUEUES, and
 * exactly one pump loop is ever the caller of the dispatch function, so the
 * running-guard degrades to a backstop assertion.
 *
 * ROUNDs are the mid-turn injection mechanism. While a turn is in flight, new
 * input for it (e.g. a child sub-session settling) is appended as a pending
 * round of THAT turn rather than queued as a separate engagement: the pump
 * re-checks the turn's round list after every dispatch, so an appended round
 * runs in the same turn context, immediately after the round that was active
 * when it arrived. (Steering INSIDE a live round remains the InputInbox's job —
 * the orchestrator drains it per iteration; rounds sit one level above that.)
 *
 * Coalescing: submissions carrying the same `coalesceKey` collapse onto an
 * already-PENDING turn with that key (as extra rounds) instead of growing the
 * queue — three children settling while the parent is busy produce one wake
 * turn with three rounds, not three turns.
 *
 * Persistence-readiness: TURNs and ROUNDs are plain serializable records with
 * ids, statuses, and timestamps; `snapshot()` projects the whole scheduler
 * state to JSON-friendly data. Nothing is written to disk yet, but a future
 * store can capture a snapshot and re-seed a runner to resume where it left
 * off — that is why submissions are accepted (queued) even while the pump is
 * stopped.
 *
 * Architecture role: Service layer. The runner knows nothing about providers,
 * MCP, or the orchestrator — it drives an injected `RoundDispatch` function,
 * which the runtime binds to `dispatchAsync`.
 */

// ---------------------------------------------------------------------------
// Data shapes (all JSON-friendly except the live Turn's internals)
// ---------------------------------------------------------------------------

/** Who produced a submission. Extend freely — the runner treats it as a tag. */
export type TurnSource = "user" | "subsession" | "api";

export type TurnStatus = "pending" | "running" | "done" | "error" | "cancelled";

export type RoundStatus =
  | "pending" // queued on its turn, not yet dispatched
  | "running" // dispatch in flight
  | "done" // dispatch returned
  | "error" // dispatch threw
  | "cancelled" // aborted while in flight — a user decision, not a failure
  | "skipped"; // never dispatched (an earlier round failed, or the turn was cancelled)

export interface Round {
  readonly roundId: string;
  readonly source: TurnSource;
  /** The input handed to the dispatch function (becomes the user message). */
  readonly content: string;
  status: RoundStatus;
  readonly createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** Dispatch outcome tag (e.g. "satisfied" / "capped") when status is done. */
  outcome?: string;
  /** Failure detail when status is "error". */
  error?: string;
}

export interface Turn {
  readonly turnId: string;
  /** Source of the submission that CREATED the turn (appended rounds keep their own). */
  readonly source: TurnSource;
  /** Pending turns sharing this key absorb later submissions as extra rounds. */
  readonly coalesceKey?: string;
  status: TurnStatus;
  /** FIFO of rounds; appended to while pending OR running, never reordered. */
  readonly rounds: Round[];
  readonly createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

/** Serializable projection of a round — the future persistence unit. */
export interface RoundSnapshot {
  roundId: string;
  source: TurnSource;
  content: string;
  status: RoundStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: string;
  error?: string;
}

/** Serializable projection of a turn — the future persistence unit. */
export interface TurnSnapshot {
  turnId: string;
  source: TurnSource;
  coalesceKey?: string;
  status: TurnStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  rounds: RoundSnapshot[];
}

/** Full scheduler state — what a future store would capture to resume. */
export interface TurnRunnerSnapshot {
  current: TurnSnapshot | null;
  pending: TurnSnapshot[];
}

// ---------------------------------------------------------------------------
// Submission API
// ---------------------------------------------------------------------------

export interface SubmitParams {
  content: string;
  source: TurnSource;
  /**
   * Set for input meant to steer or extend work already in flight (user
   * follow-ups, sub-session reports): it joins the RUNNING turn as a round so
   * it acts in that engagement's context instead of waiting behind it. Leave
   * off for work that must not run inside another engagement. Falls back to a
   * new turn when nothing is running.
   */
  preferMidTurn?: boolean;
  /**
   * Collapse onto an already-pending turn with the same key (as an extra
   * round) instead of creating another queue entry. Omit for no coalescing.
   */
  coalesceKey?: string;
}

/**
 * Receipt for a submission. `turnId`/`roundId` locate where it landed (which
 * may be an existing turn when it was appended or coalesced); `settled`
 * resolves with the owning turn's final snapshot and NEVER rejects — errors
 * are reported in the snapshot, mirroring how sub-session `settled` behaves.
 */
export interface SubmitReceipt {
  turnId: string;
  roundId: string;
  /** How the submission landed — useful for hosts and tests. */
  placement: "new-turn" | "mid-turn-round" | "coalesced-round";
  settled: Promise<TurnSnapshot>;
}

/**
 * The single operation the pump drives: run one round's content through the
 * session (the runtime binds this to `dispatchAsync`). The signal aborts the
 * round when its turn is cancelled.
 */
export type RoundDispatch = (
  content: string,
  signal: AbortSignal
) => Promise<{ outcome: string; summary?: string }>;

// ---------------------------------------------------------------------------
// Observability events
// ---------------------------------------------------------------------------

export type TurnRunnerEvent =
  | { type: "turn-queued"; turnId: string; source: TurnSource; queueDepth: number }
  | { type: "turn-start"; turnId: string; source: TurnSource; rounds: number }
  | { type: "round-start"; turnId: string; roundId: string; source: TurnSource; round: number }
  | { type: "round-done"; turnId: string; roundId: string; status: RoundStatus; error?: string }
  | { type: "turn-done"; turnId: string; source: TurnSource; status: TurnStatus; rounds: number };

export type TurnRunnerListener = (event: TurnRunnerEvent) => void;

export interface TurnRunnerOptions {
  /**
   * Ceiling on rounds a single turn may accumulate. An append past the cap
   * spills into a NEW queued turn instead — this bounds the "child settles →
   * round reacts → spawns child → settles → …" feedback loop so one turn
   * cannot run forever. Spilled submissions still coalesce among themselves.
   */
  maxRoundsPerTurn?: number;
  /** Lifecycle listener for rendering / telemetry. Errors are swallowed. */
  onEvent?: TurnRunnerListener;
}

const DEFAULT_MAX_ROUNDS_PER_TURN = 8;

// ---------------------------------------------------------------------------
// TurnRunner
// ---------------------------------------------------------------------------

export class TurnRunner {
  private readonly pendingTurns: Turn[] = [];
  private currentTurn: Turn | null = null;

  /** One resolver + abort controller per unsettled turn, keyed by turnId. */
  private readonly settleResolvers = new Map<string, (snapshot: TurnSnapshot) => void>();
  private readonly settledPromises = new Map<string, Promise<TurnSnapshot>>();
  private readonly abortControllers = new Map<string, AbortController>();

  private readonly maxRoundsPerTurn: number;
  private readonly listener?: TurnRunnerListener;

  private started = false;
  private stopping = false;
  private pumpDone: Promise<void> | null = null;
  /** Resolver that un-parks the pump when the queue was empty. */
  private wakePump: (() => void) | null = null;
  /** Resolvers parked on awaitIdle(), flushed when the last turn settles. */
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly dispatch: RoundDispatch, options: TurnRunnerOptions = {}) {
    this.maxRoundsPerTurn = options.maxRoundsPerTurn ?? DEFAULT_MAX_ROUNDS_PER_TURN;
    this.listener = options.onEvent;
  }

  // ------------------------------------------------------------------------
  // Producer API
  // ------------------------------------------------------------------------

  /**
   * Enqueue work. Placement is resolved synchronously, in priority order:
   *
   *   1. mid-turn round  — `preferMidTurn` and a turn is RUNNING with capacity
   *   2. coalesced round — `coalesceKey` matches a PENDING turn with capacity
   *   3. new turn        — everything else (also the spill path past the cap)
   *
   * Safe to call from any producer at any time, including while the pump is
   * stopped (the submission waits in the queue — the future resume path).
   */
  public submit(params: SubmitParams): SubmitReceipt {
    const round = makeRound(params);

    // 1. Same-engagement feedback lands on the live turn.
    if (
      params.preferMidTurn &&
      this.currentTurn &&
      this.currentTurn.status === "running" &&
      this.currentTurn.rounds.length < this.maxRoundsPerTurn
    ) {
      this.currentTurn.rounds.push(round);
      return this.receiptFor(this.currentTurn, round, "mid-turn-round");
    }

    // 2. Collapse onto a pending turn with the same coalesce key.
    if (params.coalesceKey) {
      const target = this.pendingTurns.find(
        (turn) =>
          turn.coalesceKey === params.coalesceKey &&
          turn.status === "pending" &&
          turn.rounds.length < this.maxRoundsPerTurn
      );
      if (target) {
        target.rounds.push(round);
        return this.receiptFor(target, round, "coalesced-round");
      }
    }

    // 3. New engagement.
    const turn = makeTurn(params, round);
    this.registerTurn(turn);
    this.pendingTurns.push(turn);
    this.emit({
      type: "turn-queued",
      turnId: turn.turnId,
      source: turn.source,
      queueDepth: this.pendingTurns.length,
    });
    this.kickPump();
    return this.receiptFor(turn, round, "new-turn");
  }

  /**
   * Cancel a turn. Pending: removed from the queue and settled as cancelled
   * without ever dispatching. Running: its abort signal fires and the active
   * round is allowed to unwind. Unknown/settled ids return false.
   */
  public cancel(turnId: string): boolean {
    const pendingIndex = this.pendingTurns.findIndex((turn) => turn.turnId === turnId);
    if (pendingIndex !== -1) {
      const [turn] = this.pendingTurns.splice(pendingIndex, 1);
      turn.status = "cancelled";
      turn.endedAt = Date.now();
      for (const round of turn.rounds) round.status = "skipped";
      this.settleTurn(turn);
      return true;
    }
    if (this.currentTurn?.turnId === turnId) {
      this.abortControllers.get(turnId)?.abort();
      return true;
    }
    return false;
  }

  /**
   * Abort whatever turn is in flight — the host's "stop" affordance, saving
   * callers from fishing the live turnId out of a snapshot. Best-effort by
   * nature: the active round unwinds as soon as the dispatch honours its
   * signal (worst case, at the round boundary); remaining rounds are skipped.
   */
  public cancelCurrent(): boolean {
    return this.currentTurn ? this.cancel(this.currentTurn.turnId) : false;
  }

  /**
   * Complete stoppage: flush PENDING turns first — so the pump cannot promote
   * one while the in-flight turn unwinds — then abort the current turn.
   * Returns how many turns were cancelled.
   */
  public cancelAll(): number {
    let cancelled = 0;
    while (this.pendingTurns.length > 0) {
      const tail = this.pendingTurns[this.pendingTurns.length - 1];
      if (this.cancel(tail.turnId)) cancelled += 1;
    }
    if (this.cancelCurrent()) cancelled += 1;
    return cancelled;
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

  /**
   * Graceful stop: the in-flight turn (all its rounds) finishes; PENDING turns
   * stay queued so a snapshot taken afterwards captures them — the resume
   * contract. Resolves once the pump has fully exited.
   */
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

  /** True when a turn is in flight OR waiting — "the session has work". */
  public get isBusy(): boolean {
    return this.currentTurn !== null || this.pendingTurns.length > 0;
  }

  /**
   * Resolves once nothing is in flight and nothing is queued. The bridge
   * between a synchronous cancel and operations that need true quiescence
   * (reset/compact): cancelAll() fires the aborts, but the in-flight turn
   * unwinds asynchronously — mutating state before it settles would let the
   * dying turn write into the fresh state.
   */
  public awaitIdle(): Promise<void> {
    if (!this.isBusy) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  public get pendingCount(): number {
    return this.pendingTurns.length;
  }

  /** JSON-friendly projection of the whole scheduler — the persistence seam. */
  public snapshot(): TurnRunnerSnapshot {
    return {
      current: this.currentTurn ? toTurnSnapshot(this.currentTurn) : null,
      pending: this.pendingTurns.map(toTurnSnapshot),
    };
  }

  // ------------------------------------------------------------------------
  // The pump — the ONLY caller of `dispatch`
  // ------------------------------------------------------------------------

  private async pump(): Promise<void> {
    while (!this.stopping) {
      const turn = this.pendingTurns.shift();
      if (!turn) {
        await this.parkPump();
        continue;
      }
      await this.runTurn(turn);
    }
  }

  /**
   * Run one turn to completion: dispatch rounds in order, RE-CHECKING the
   * round list after each await so rounds appended mid-turn are picked up in
   * the same engagement. All status transitions between awaits are synchronous,
   * so a submit() can never observe a half-updated turn.
   */
  private async runTurn(turn: Turn): Promise<void> {
    this.currentTurn = turn;
    turn.status = "running";
    turn.startedAt = Date.now();
    this.emit({ type: "turn-start", turnId: turn.turnId, source: turn.source, rounds: turn.rounds.length });

    const controller = this.abortControllers.get(turn.turnId)!;
    let failed = false;

    for (;;) {
      const round = turn.rounds.find((candidate) => candidate.status === "pending");
      if (!round) break;

      if (controller.signal.aborted) {
        round.status = "skipped";
        continue;
      }

      round.status = "running";
      round.startedAt = Date.now();
      this.emit({
        type: "round-start",
        turnId: turn.turnId,
        roundId: round.roundId,
        source: round.source,
        round: turn.rounds.indexOf(round) + 1,
      });

      try {
        const result = await this.dispatch(round.content, controller.signal);
        round.status = "done";
        round.outcome = result.outcome;
      } catch (err) {
        // Distinguish a user stop from a genuine failure so a cancelled turn
        // never renders (or persists) as a broken one.
        if (controller.signal.aborted) {
          round.status = "cancelled";
        } else {
          round.status = "error";
          round.error = err instanceof Error ? err.message : String(err);
          failed = true;
        }
      }
      round.endedAt = Date.now();
      this.emit({
        type: "round-done",
        turnId: turn.turnId,
        roundId: round.roundId,
        status: round.status,
        error: round.error,
      });

      // One failed round fails the engagement; later rounds would run against
      // a context the failure may have corrupted, so they are skipped, not run.
      if (failed) {
        for (const remaining of turn.rounds) {
          if (remaining.status === "pending") remaining.status = "skipped";
        }
        break;
      }
    }

    turn.status = controller.signal.aborted ? "cancelled" : failed ? "error" : "done";
    turn.endedAt = Date.now();
    this.currentTurn = null;
    this.emit({
      type: "turn-done",
      turnId: turn.turnId,
      source: turn.source,
      status: turn.status,
      rounds: turn.rounds.length,
    });
    this.settleTurn(turn);
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  private registerTurn(turn: Turn): void {
    this.abortControllers.set(turn.turnId, new AbortController());
    this.settledPromises.set(
      turn.turnId,
      new Promise<TurnSnapshot>((resolve) => {
        this.settleResolvers.set(turn.turnId, resolve);
      })
    );
  }

  private receiptFor(turn: Turn, round: Round, placement: SubmitReceipt["placement"]): SubmitReceipt {
  return {
      turnId: turn.turnId,
      roundId: round.roundId,
      placement,
      settled: this.settledPromises.get(turn.turnId)!,
    };
  }

  private settleTurn(turn: Turn): void {
    const resolve = this.settleResolvers.get(turn.turnId);
    this.settleResolvers.delete(turn.turnId);
    this.settledPromises.delete(turn.turnId);
    this.abortControllers.delete(turn.turnId);
    resolve?.(toTurnSnapshot(turn));

    if (!this.isBusy) {
      const waiters = this.idleWaiters.splice(0);
      for (const wake of waiters) wake();
    }
  }

  /** Block the pump until submit()/stop() kicks it. */
  private parkPump(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wakePump = resolve;
    });
  }

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

// ---------------------------------------------------------------------------

function makeRound(params: SubmitParams): Round {
  return {
    roundId: randomUUID(),
    source: params.source,
    content: params.content,
    status: "pending",
    createdAt: Date.now(),
  };
}

function makeTurn(params: SubmitParams, firstRound: Round): Turn {
  return {
    turnId: randomUUID(),
    source: params.source,
    coalesceKey: params.coalesceKey,
    status: "pending",
    rounds: [firstRound],
    createdAt: Date.now(),
  };
}

function toRoundSnapshot(round: Round): RoundSnapshot {
  return {
    roundId: round.roundId,
    source: round.source,
    content: round.content,
    status: round.status,
    createdAt: round.createdAt,
    startedAt: round.startedAt,
    endedAt: round.endedAt,
    outcome: round.outcome,
    error: round.error,
  };
}

function toTurnSnapshot(turn: Turn): TurnSnapshot {
  return {
    turnId: turn.turnId,
    source: turn.source,
    coalesceKey: turn.coalesceKey,
    status: turn.status,
    createdAt: turn.createdAt,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    rounds: turn.rounds.map(toRoundSnapshot),
  };
}
