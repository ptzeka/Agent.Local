# Turns & Rounds — the session's scheduling core

*Written 2026-06-12, verified against commit `e742c2f` (29/29 suites,
138/138 tests). Source of truth:
[turn-runner.ts](src/agent/src/agent/runners/turn-runner.ts) and the wiring
in [agent-runtime.ts](src/agent/src/agent/runtime/agent-runtime.ts).*

This document explains the TurnRunner — the single-writer scheduler that
decides **when** the orchestrator runs and **what input** it runs on. It is
the layer that turned the runtime from "one blocking dispatch at a time" into
a multi-producer session that can absorb user input, sub-session reports, and
(future) API calls without races.

---

## 1. The execution hierarchy

Four nested levels, coarse to fine. Each level has a different owner and a
different job:

```
TurnRunner queue          FIFO of TURNs; exactly ONE pump consumes it
  └─ TURN                 one queued engagement — a user request, a
     │                    sub-session report, a future API call
     └─ ROUND             one orchestrator dispatch within the turn
        │                 (one full dispatchAsync: status guard → run → persist)
        └─ iterations     the orchestrator's INTERNAL model loop
                          (ask model → tool calls → evaluator gate → repeat)
```

| Level | Owner | One unit means | Bounded by |
|---|---|---|---|
| Turn | TurnRunner | one engagement with the session | queue order (FIFO) |
| Round | TurnRunner (within a turn) | one `dispatchAsync` call | `maxRoundsPerTurn` (default 8) |
| Iteration | Orchestrator | one model request + its tool calls | orchestrator iteration cap |

The TurnRunner deliberately knows nothing below the round boundary: it drives
an injected `RoundDispatch` function and never imports providers, MCP, or the
orchestrator (Service layer, dependency-injected — see
[turn-runner.ts:159](src/agent/src/agent/runners/turn-runner.ts#L159)).

---

## 2. Why it exists

`AgentRuntime.dispatchAsync` is **single-flight**: it throws if
`session.status === "running"` ([agent-runtime.ts:195](src/agent/src/agent/runtime/agent-runtime.ts#L195)).
That guard is correct but fragile the moment more than one producer can start
work:

- the **user** types in the REPL,
- a **sub-session** settles and wants its report processed,
- later, an **HTTP API** posts a message.

With direct dispatch, two producers collide on the guard and one throws — a
race decided by timing. The TurnRunner removes the race **structurally**
instead of defensively: every producer *enqueues* via `submit()`, and exactly
one pump loop is ever the caller of `dispatchAsync`. The running-guard
degrades to a backstop assertion that should never fire.

The second problem it solves is **lost reports**. Before the turn loop, a
sub-session finishing while nothing was running just emitted a notification —
visible in the CLI, invisible to the model. Now the report becomes a round in
the conversation, so the orchestrator actually *reasons over* the child's
result (reconciles it with the original request, does follow-up work, or
confirms the outcome to the user — see `formatSubSessionReport`,
[agent-runtime.ts:496](src/agent/src/agent/runtime/agent-runtime.ts#L496)).

---

## 3. Data model

All shapes are plain serializable records — that is a design constraint, not
an accident (see §9 Persistence).

```ts
Turn {
  turnId, source,            // source of the CREATING submission
  coalesceKey?,              // pending turns sharing this key absorb later submissions
  status,                    // pending | running | done | error | cancelled
  rounds: Round[],           // FIFO; appended while pending OR running, never reordered
  createdAt, startedAt?, endedAt?
}

Round {
  roundId, source,           // each round keeps its OWN source
  content,                   // the input handed to dispatch (becomes the user message)
  status,                    // pending | running | done | error | cancelled | skipped
  outcome?,                  // dispatch outcome tag ("satisfied" / "capped") when done
  error?,                    // failure detail when status is "error"
  createdAt, startedAt?, endedAt?
}
```

Round status nuances worth knowing:

- **cancelled** — aborted while in flight. *A user decision, not a failure*;
  a cancelled turn never renders or persists as broken.
- **skipped** — never dispatched, because an earlier round failed or the turn
  was cancelled before this round's slot came up.

---

## 4. Submission: where input lands

`submit({ content, source, preferMidTurn?, coalesceKey? })` resolves
placement **synchronously**, in strict priority order
([turn-runner.ts:240](src/agent/src/agent/runners/turn-runner.ts#L240)):

```
1. mid-turn round    preferMidTurn AND a turn is RUNNING with round capacity
                     → appended to the LIVE turn; runs in that engagement's
                       context, right after the currently-active round
2. coalesced round   coalesceKey matches a PENDING turn with capacity
                     → appended to that queued turn as an extra round
3. new turn          everything else — including the spill path when a turn
                     is already at maxRoundsPerTurn
```

The caller gets a `SubmitReceipt`: `turnId` + `roundId` (where it landed),
`placement` (which branch fired), and `settled` — a promise resolving with
the owning turn's final snapshot. `settled` **never rejects**; errors are
reported inside the snapshot, mirroring the sub-session `settled` contract.

`submit()` is safe to call at any time, including while the pump is stopped —
the submission waits in the queue. That is deliberate: it is the future
resume path (load a snapshot, re-seed the queue, start the pump).

### The two opt-in flags

- **`preferMidTurn`** — "this input belongs to the work in flight." Used by
  user follow-ups and sub-session reports. Falls back to a new turn when
  nothing is running. Leave it off for work that must *not* execute inside
  another engagement's context.
- **`coalesceKey`** — "don't grow the queue with duplicates of me." Three
  children settling while the parent is busy produce **one** wake turn with
  three rounds, not three queued turns. The runtime uses the constant key
  `"subsession-report"` for all child reports.

### The round cap

`maxRoundsPerTurn` (default **8**) is the brake on a feedback loop the
mid-turn mechanism would otherwise enable: child settles → report round runs
→ spawns another child → settles → another round… One turn could run forever.
An append past the cap **spills into a new queued turn** instead — the work
still happens, just as a fresh engagement. Spilled submissions still coalesce
among themselves.

---

## 5. The pump: one consumer, strict ordering

The pump is a single async loop and **the only caller of `dispatch`**
([turn-runner.ts:393](src/agent/src/agent/runners/turn-runner.ts#L393)):

```
pump:  shift next pending TURN  ──none?──▶ park until submit()/stop() kicks
         │
         ▼
runTurn: status → running
  loop:
    find first PENDING round           ← RE-CHECKED after every await, so
      │  none? → turn complete           rounds appended mid-turn are picked
      ▼                                  up in the SAME engagement
    aborted? → round skipped, continue
    round → running
    await dispatch(round.content, signal)
      ├─ ok      → round done (+outcome)
      ├─ abort   → round cancelled        (user stop, not a failure)
      └─ throw   → round error → ALL remaining pending rounds SKIPPED
    emit round-done
  turn status: cancelled | error | done
  settle the turn (resolve `settled`, flush idle waiters)
```

Two invariants the implementation leans on:

1. **All status transitions between awaits are synchronous** — a `submit()`
   can never observe a half-updated turn.
2. **One failed round fails the engagement.** Later rounds would run against
   a context the failure may have corrupted, so they are skipped, not run.
   (A *cancelled* round does not mark the turn as failed.)

---

## 6. Cancellation & quiescence

Three granularities, all on the runner:

| Call | Effect |
|---|---|
| `cancel(turnId)` | Pending: removed and settled as cancelled, never dispatched. Running: its `AbortController` fires; the active round unwinds at the dispatch's discretion (worst case, at the round boundary); remaining rounds are skipped. |
| `cancelCurrent()` | The host's "stop" affordance — aborts whatever is in flight without fishing the turnId out of a snapshot. |
| `cancelAll()` | Flushes **pending turns first** (so the pump cannot promote one while the in-flight turn unwinds), then aborts the current turn. |

For operations that need true quiescence — `reset()`, `compact()` — cancel
alone is not enough: aborts fire synchronously but the in-flight turn unwinds
*asynchronously*. `awaitIdle()` resolves once nothing is in flight and
nothing is queued; mutating state before that would let the dying turn write
into the fresh state. The runtime's pattern is always:

```ts
this.stopAllWork();              // sweep children FIRST, then cancelAll()
await this.turnRunner?.awaitIdle();
// …now safe to clear/rebuild
```

Children are swept first and through their settle guard, because a dying
child would otherwise enqueue a wake turn into the very queue being flushed
([agent-runtime.ts:271](src/agent/src/agent/runtime/agent-runtime.ts#L271)).

`stop()` (graceful) is different from cancellation: the in-flight turn
finishes all its rounds, and **pending turns stay queued** so a snapshot
taken afterwards captures them — the resume contract.

---

## 7. How the runtime wires it

The loop is **opt-in per host**
([agent-runtime.ts:248](src/agent/src/agent/runtime/agent-runtime.ts#L248)):

- **REPL** calls `startTurnLoop()` once; user input goes through
  `turnRunner.submit({ content, source: "user", preferMidTurn: true })`
  ([repl.ts:134](src/agent/src/cli/repl.ts#L134)). The prompt stays live
  during a turn, so a follow-up typed mid-run joins the live engagement as a
  round.
- **Headless single runs** (and executor child runtimes) never start the
  loop — they keep the direct `dispatchAsync` path. That is why the
  running-guard backstop still exists.

`startTurnLoop` binds the pump's `RoundDispatch` to `dispatchAsync` and
subscribes the **auto-wake**: every sub-session notification is submitted as
`{ source: "subsession", preferMidTurn: true, coalesceKey: "subsession-report" }`
([agent-runtime.ts:296](src/agent/src/agent/runtime/agent-runtime.ts#L296)).
So a child's report lands as:

- a **mid-turn round** when the parent is mid-engagement (the report is acted
  on in context), or
- a **coalesced wake turn** when the parent is idle (the session wakes itself,
  processes the report, and answers unprompted).

One subtlety: `reset()` re-runs `build()`, which constructs a **new**
SessionManager — an active loop's wake subscription would silently point at
the dead manager. `rewireTurnWake()` is therefore called from both
`startTurnLoop` and `build()` to re-bind the subscription to the instance
that will actually fire.

---

## 8. Layering: rounds vs. the InputInbox

Two injection mechanisms coexist; they sit at **different levels** and do not
overlap:

| Mechanism | Level | When the input is seen |
|---|---|---|
| **Round** (TurnRunner) | between dispatches | as the user message of its own full `dispatchAsync`, after the active round completes |
| **InputInbox** (`runtime.injectInput`) | inside a live round | drained at the start of the orchestrator's *next iteration* within the current dispatch |

Rule of thumb: the inbox **steers** work already executing; a round **adds an
engagement step**. The pump re-checks the round list after every await, the
orchestrator drains the inbox every iteration — same pattern, one level apart.

---

## 9. Observability & persistence-readiness

**Events** (`onEvent` on the runner): `turn-queued`, `turn-start`,
`round-start`, `round-done`, `turn-done` — each carrying ids, source, and
status. The CLI's rendering policy
([render.ts:147](src/agent/src/cli/render.ts#L147)) is deliberately quiet for
plain user turns (the prompt/await flow already narrates those); only
out-of-band activity gets a line:

- a queued/auto-wake turn from a settling child ("why is the agent talking
  unprompted?"),
- rounds beyond the first (mid-turn feedback folded in),
- round errors — which must surface here or nowhere, because the REPL no
  longer awaits a turn's settle (the prompt stays live for mid-turn
  injection),
- cancelled turns.

**Persistence:** nothing is written to disk yet, but every shape is
JSON-friendly by construction, and `snapshot()` projects the entire scheduler
(`{ current, pending }` with full turn/round records) in one call. A future
store can capture a snapshot and re-seed a runner to resume where it left
off — which is also why `submit()` accepts work while the pump is stopped,
and why a graceful `stop()` leaves pending turns in the queue.

---

## 10. Invariants (the contract in one list)

1. Exactly one pump per session ever calls `dispatchAsync`; producers only
   ever enqueue.
2. Placement is synchronous and deterministic: mid-turn → coalesce → new
   turn, in that order, capacity permitting.
3. Rounds within a turn are FIFO, appended-only, never reordered.
4. The round list is re-checked after every await — mid-turn appends run in
   the same engagement.
5. One *failed* round skips the rest of its turn; one *cancelled* round does
   not mark the turn failed.
6. `settled` never rejects — outcomes, including errors, live in the snapshot.
7. `maxRoundsPerTurn` (8) bounds any settle→react→spawn feedback loop by
   spilling into a new turn.
8. Reset/compact require `cancelAll()` **and** `awaitIdle()` — abort is
   synchronous, unwinding is not.
9. Headless hosts may bypass the loop entirely; the `running`-status guard in
   `dispatchAsync` is their (and the loop's) backstop.
