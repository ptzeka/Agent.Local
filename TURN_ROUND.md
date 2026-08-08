# Turns — the session's scheduling core

*Rewritten 2026-07-30; every symbol and line anchor re-verified against the
working tree on 2026-08-02 (after `ToolCaller`, the sub-session layer, and the
executor seam were removed).
Source of truth: [turn-runner.ts](src/agent/src/agent/runners/turn-runner.ts),
[turn-loop.ts](src/agent/src/agent/runners/turn-loop.ts),
[turn.ts](src/agent/src/agent/runners/turn.ts), and the wiring in
[agent-runtime.ts](src/agent/src/agent/runtime/agent-runtime.ts).*

> **Note on the name.** An earlier design modelled a *turn* as a container of
> queued **rounds** (`Turn { rounds: Round[] }`, `submit()`, `coalesceKey`,
> `maxRoundsPerTurn`). That layer is gone. The runner is now **contentless**:
> prompt text lives in the [InputInbox](src/agent/src/agent/runners/input-inbox.ts),
> one prompt becomes one turn, and the runner only carries the abort plumbing.
> The file keeps its name for link stability; wherever this document says
> "round" it means *one iteration inside a turn*.

This document explains the two schedulers that stack on top of each other: the
**TurnRunner** (single-writer pump — *when* a turn runs) and the **TurnLoop**
(the agentic loop — *what happens inside* one turn).

---

## 1. The execution hierarchy

Four nested levels, coarse to fine, each with its own owner and its own file:

```
InputInbox                FIFO of PROMPTS per sessionId; producers push, nobody dispatches
  └─ TurnRunner pump      exactly ONE loop; the only caller of dispatch      turn-runner.ts
     └─ TURN              one drained prompt, end to end                     turn-loop.ts + turn.ts
        │                 prologue → iterations → epilogue
        └─ iteration      one model request + its tool calls                 model-caller.ts
                                                                             Turn.runToolCalls
```

| Level | Owner | One unit means | Bounded by |
|---|---|---|---|
| Prompt | `InputInbox` | one queued piece of input | nothing — unbounded queue |
| Turn | `TurnRunner` | one `dispatchAsync`, one drained prompt | one at a time, serial |
| Iteration | `TurnLoop.iterate` | one `ModelCaller.call` + its tool calls | `TurnProfile.maxIterations` |
| Tool call | `Turn.runToolCalls` | one `ScopedToolClient.callTool`, all calls in `Promise.all` | the turn's `AbortSignal` |

The layering is strict and each seam is a plain function/interface:

- `TurnRunner` knows nothing below `dispatch(signal)` — it never imports
  providers, MCP, or the loop ([turn-runner.ts:17](src/agent/src/agent/runners/turn-runner.ts#L17)).
- `TurnLoop` holds **control flow only**; per-turn state and assembly live in
  `Turn` ([turn-loop.ts:55](src/agent/src/agent/runners/turn-loop.ts#L55)).
- `Turn` records and settles; it never drives control flow
  ([turn.ts:32](src/agent/src/agent/runners/turn.ts#L32)).

---

## 2. The `runners/` map

Every file in [src/agent/src/agent/runners/](src/agent/src/agent/runners/),
grouped by the job it does.

### Scheduling — when a turn runs

| File | Role |
|---|---|
| [turn-runner.ts](src/agent/src/agent/runners/turn-runner.ts) | The pump. `wake()` / `cancel*()` / `start()` / `stop()` / `awaitIdle()`. Contentless: holds a `CurrentTurn` (id, source, status, `AbortController`) and nothing else. |
| [input-inbox.ts](src/agent/src/agent/runners/input-inbox.ts) | `InputInbox` — the prompt queue, keyed by `sessionId`. One instance per runtime, minted by `InputInboxMiddleware` ([runtime/middleware/input-inbox.ts:11](src/agent/src/agent/runtime/middleware/input-inbox.ts#L11)), so an agent's child runtime gets its own. `push` also **wakes** the runner, and owns idempotency (§4). |

### The loop — what happens inside a turn

| File | Role |
|---|---|
| [turn-loop.ts](src/agent/src/agent/runners/turn-loop.ts) | `SessionRunner` implementation: prologue → `iterate` → epilogue, plus `capped`. Stateless — holds only its role and its four policy slots. |
| [turn.ts](src/agent/src/agent/runners/turn.ts) | `Turn` — per-turn state: profile, provider, scoped clients, visible tools, `DispatchTracker`, transcript writes (`append` persists, `injectTransient` doesn't), and the four terminal shapes (`settle` / `fail` / `budgetCapped` / `finalizeReported`). `Turn.open()` (L80) is the assembly step; `Turn.idle()` (L136) is the empty-wake short circuit; `Turn.replayOf()` (L126) is the idempotent replay. `runToolCalls()` (L210) runs one iteration's calls concurrently, pairs results into the transcript, flushes, and returns the landed `report_result` if any — the loop decides what that means. |
| [turn-profile.ts](src/agent/src/agent/runners/turn-profile.ts) | `resolveTurnProfile` — the per-role knobs as **data**: `maxIterations`, `temperature`, `needsTurnBinding`, `completion` contract, `evaluatorPass`. The one place a role record is read — a new kind of turn is a role record, never a branch. |
| [model-caller.ts](src/agent/src/agent/runners/model-caller.ts) | `ModelCaller` — one model call: request anchor, streaming deltas, native-vs-prompted tool-call normalisation, usage stamping, append. Decides nothing. |

### Policies — the four extension slots

Slots declared in [policies/types.ts](src/agent/src/agent/runners/policies/types.ts);
anything omitted falls back to the built-in default
([turn-loop.ts:65](src/agent/src/agent/runners/turn-loop.ts#L65)).

| Slot | Default | File |
|---|---|---|
| `ContextProvider` (one) | `SnapshotContextProvider` | [policies/snapshot-context-provider.ts](src/agent/src/agent/runners/policies/snapshot-context-provider.ts) |
| `CompactionPolicy` (one) | `SummarizeCompaction` | [policies/summarize-compaction.ts](src/agent/src/agent/runners/policies/summarize-compaction.ts) |
| `ContextContributor[]` (many, additive) | `[MemoryContributor]` | [policies/memory-contributor.ts](src/agent/src/agent/runners/policies/memory-contributor.ts) |
| `CompletionPolicy` (one, chosen by profile) | per `profile.completion` | [policies/completion.ts](src/agent/src/agent/runners/policies/completion.ts) |

Only the completion policy can **end** a turn. Contributors are additive and
therefore unbounded; the other three are singular because they decide.

### Terminal pass & reporting

| File | Role |
|---|---|
| [evaluator-pass.ts](src/agent/src/agent/runners/evaluator-pass.ts) | Runs **after** the turn settles: a separate judge role reads this turn's transcript and stamps PASS / FAIL / INCOMPLETE. Never changes `outcome`. |
| [policies/dispatch-result.ts](src/agent/src/agent/runners/policies/dispatch-result.ts) | `renderReport` / `stampReport` — writes a dispatched role's validated record into the **parent** conversation via the role's `report` template. |

### Cross-cutting

| File | Role |
|---|---|
| [middleware/runner-middleware.ts](src/agent/src/agent/runners/middleware/runner-middleware.ts) | `RunnerContext` (the one per-turn bundle) + the onion seam `composeRunnerPipeline`, execution-scoped twin of the build-scoped `IMiddleware`. |
| [middleware/turn-counter-middleware.ts](src/agent/src/agent/runners/middleware/turn-counter-middleware.ts) | Folds usage into the `MetricsRegistry` off the event bus: own spend rides `orchestrator-message`, delegated subtree spend rides `tool-result`. The same subscription enforces the token ceilings (§8). |
| [policies/budget.ts](src/agent/src/agent/runners/policies/budget.ts) | Pure ceiling arithmetic + the cancel-reason narrowing that separates a budget stop from a user stop. |
| [runner-events.ts](src/agent/src/agent/runners/runner-events.ts) | `OrchestratorEventTypes` — the event vocabulary every unit above publishes on. |
| [summarizer.ts](src/agent/src/agent/runners/summarizer.ts) | `Summarizer`, `SUMMARY_TAG`, `buildSummaryMessage`, `isSummaryMessage` — see §7. |

That table is the whole directory: `ls src/agent/src/agent/runners/**/*.ts` returns
these 18 files and nothing else.

---

## 3. Why the runner exists

`AgentRuntime.dispatchAsync` is **single-flight**: it throws if
`session.status === "running"`
([agent-runtime.ts:177](src/agent/src/agent/runtime/agent-runtime.ts#L177)).
That guard is correct but fragile the moment more than one producer can start
work:

- the **user** types in the REPL (`source: "user"`),
- an **HTTP API** posts a message (`source: "api"`).

Those are the two members of `TurnSource`
([turn-runner.ts:12](src/agent/src/agent/runners/turn-runner.ts#L12)); a third,
`"subsession"`, existed while detached child sessions did and went with them —
an agent's answer now returns as an ordinary tool result inside the calling
turn, so there is nothing to wake anyone up about.

With direct dispatch, two producers collide on the guard and one throws — a
race decided by timing. The runner removes the race **structurally**: every
producer pushes to the inbox and wakes the runner, and exactly one pump loop is
ever the caller of `dispatchAsync`. The running-guard degrades to a backstop
that should never fire.

---

## 4. Submission: the inbox is the queue

There is **no pending-turn queue**. Unconsumed work lives as text in the inbox,
and the runner carries a single boolean:

```ts
InputInbox (input-inbox.ts)                     TurnRunner (turn-runner.ts)
  queues: Map<sessionId, InboxItem[]>             pending: boolean   // "a wake is owed"
  setOnPush(listener)              L61   ──────▶  wake(source)       // kicks the pump
  push(sessionId, content, source?, key?) L71     current: CurrentTurn | null
  dequeue(sessionId): InboxItem | null    L102
  hasPending(sessionId): boolean          L110 ◀─ shouldRun()        // the work predicate
  clear(sessionId)                        L116
  executedRecord(sessionId, item)         L126   // the idempotency half — see below
  recordExecuted(sessionId, item, record) L138
```

An `InboxItem` is `{ content, fingerprint, source }`. The fingerprint —
`sha256(sessionId + source + normalized content)`, or an explicit idempotency key
when the producer supplies one — travels **with** the content, because the turn
that runs it is what records that it ran.

Consequences of that shape, all deliberate:

- **One prompt per turn.** `dequeue` pops exactly one entry in FIFO order
  ([input-inbox.ts:102](src/agent/src/agent/runners/input-inbox.ts#L102)); the
  drained request then carries across every iteration of that turn. A prompt
  queued *mid-turn* is left for the pump to replay as the **next** turn
  ([turn-loop.ts:140](src/agent/src/agent/runners/turn-loop.ts#L140)).
- **The wake is idempotent.** `wake()` just sets `pending = true` and kicks;
  three producers waking during one turn produce one follow-up turn per queued
  prompt, not per wake.
- **`shouldRun` guards the stillborn turn.** The pump checks
  `inbox.hasPending` before dispatching, so a wake whose content the running
  turn already drained settles without running an empty turn
  ([turn-runner.ts:171](src/agent/src/agent/runners/turn-runner.ts#L171)).
  `TurnLoop.run` re-checks the same predicate and returns `Turn.idle()` rather
  than assembling tools it would discard
  ([turn-loop.ts:78](src/agent/src/agent/runners/turn-loop.ts#L78)).
- **Injection is PULL, not push.** The loop is the sole writer of the
  `Conversation`; an outside mutation would race it. Producers enqueue, the
  loop drains at a safe boundary — the `hasPending` / `pullInjectedPrompt` pair
  on `RunnerContext`
  ([runner-middleware.ts:26-27](src/agent/src/agent/runners/middleware/runner-middleware.ts#L26-L27)),
  consumed at [turn-loop.ts:87](src/agent/src/agent/runners/turn-loop.ts#L87).
- **Even a direct dispatch goes through the inbox.** `dispatchAsync(input)`
  pushes `input` first, so there is no separate first-message path
  ([agent-runtime.ts:182](src/agent/src/agent/runtime/agent-runtime.ts#L182)).

### Idempotency: the inbox is where a request exists before it is a turn

That makes it the only sane home for both halves of duplicate handling, and it
keeps the runner contentless:

| Half | What it does | Default |
|---|---|---|
| Pending-duplicate drop | a push whose fingerprint is already queued is absorbed — and does **not** wake the pump | on, for `api` (`DEFAULT_DEDUPED_SOURCES`, [input-inbox.ts:32](src/agent/src/agent/runners/input-inbox.ts#L32)) |
| Executed ledger | a settled turn records `fingerprint → { turnId, outcome, finalContent }`; a later match short-circuits to that record | **off** (`idempotencyTtlMs: 0`) |

The drop half exists for retrying machine producers: an API caller that resends
the same message while the first is still queued must get **one** turn, not two.

Both halves are scoped to non-human sources on purpose. A person legitimately
types `yes`, `continue`, `again` and must get a fresh turn every time, so `user`
input is never deduped and never replayed.

The ledger is consulted in `TurnLoop.run` **before** `Turn.open`, so a replay
costs no tool mounting, no server binding, and no model call. When the inbox goes
durable (§11) this is one swap there — a unique index on
`(session_id, fingerprint)` — and no change in the loop.

---

## 5. The pump: one consumer, self-perpetuating

The pump is a single async loop and **the only caller of `dispatch`**
([turn-runner.ts:160](src/agent/src/agent/runners/turn-runner.ts#L160)):

```
pump:  pending wake OR inbox still has input?
         │  no  → park until wake()/stop() kicks
         ▼  yes
       clear `pending`, take its source
       shouldRun() still true?  ──no──▶ flush idle waiters, loop
         │ yes
         ▼
runTurn: mint turnId + AbortController (signal = any([parentSignal, own]))
         emit turn-start
         await dispatch(signal)
           ├─ ok    → done       (or cancelled, if the signal fired)
           └─ throw → cancelled if aborted, else error
         emit turn-done, clear `current`, flush idle waiters
```

Two properties the implementation leans on:

1. **Self-perpetuation over parking.** The loop condition is
   `pending || hasQueuedInput()`, so a multi-prompt inbox drains as consecutive
   turns instead of parking after the first
   ([turn-runner.ts:164](src/agent/src/agent/runners/turn-runner.ts#L164)).
2. **An abort is never an error.** A user stop must not render or persist as a
   broken turn, so the status is decided by `signal.aborted`, not by whether
   `dispatch` threw ([turn-runner.ts:183](src/agent/src/agent/runners/turn-runner.ts#L183)).
   `hasQueuedInput` also returns `false` once the parent signal is aborted —
   otherwise a queued prompt that can never dispatch would spin the pump
   ([turn-runner.ts:143](src/agent/src/agent/runners/turn-runner.ts#L143)).

---

## 6. Inside a turn: prologue → iterate → epilogue

`TurnLoop.run` ([turn-loop.ts:75](src/agent/src/agent/runners/turn-loop.ts#L75))
is the whole turn:

```
TurnLoop.run(ctx):                                              turn-loop.ts L75
  ctx.hasPending()? ──no──▶ Turn.idle()      // cold wake, nothing to assemble   L78

  request = ctx.pullInjectedPrompt()         // popped BEFORE assembly (see §8)  L87
  ctx.executedRecord(request)? ──hit──▶ Turn.replayOf(record)  // no model/tool calls

  Turn.open(ctx, role)                       // profile, provider, ScopedToolClient.forRole,
                                             // visible tools, DispatchTracker, TurnResultCapture,
                                             // bindTurnScopedServers (needsTurnBinding roles only)
  ── runPrologue (ONCE, order is load-bearing) ───────────────────────  L205
     1  contextProvider.build()   → turn.setContextMessages()  // standing prefix
     2  compaction.applyIfNeeded()                         // may rewrite history (§7)
     3  anchorRequest()           → append the popped prompt          L216
     4  contributors.contribute() ×N                       // key off the anchored request

  ── iterate (1..profile.maxIterations) ──────────────────────────────  L140
     aborted? → throw
     reply = ModelCaller.call(turn, ctx)
     reply has tool calls? → turn.runToolCalls(reply.toolCalls)   // turn.ts L210
                               ├─ report_result landed → turn.finalizeReported()  ⇒ END
                               └─ otherwise            → next iteration
     else → completion.judge(turn, reply, ctx)
              ├─ settle   → turn.settle(msg, outcome)      ⇒ END
              ├─ fail     → turn.fail(reason)              ⇒ END
              └─ continue → turn.nudge(text), next iteration
     loop exhausted → capped()                             ⇒ END      L233

  ── runEpilogue (ONCE, after settling) ──────────────────────────────  L180
     profile.evaluatorPass && evaluator client mounted?
       → runEvaluatorPass() → result.evaluation = { status, reason }
```

Why the prologue order is fixed
([turn-loop.ts:205](src/agent/src/agent/runners/turn-loop.ts#L205)) — steps 1 and
2 both call `seedOpeningSet()`, which rebuilds the working set and **resets
`turnStartIndex` to the current end**:

- run either one *after* the drain and the request falls **before** the index,
  so `transcriptOfTurn()` — what the evaluator judges — no longer contains the
  request it is judging against;
- compaction is worse still: the request is already persisted by then, so
  `replaceHistory` could fold it into the summarized prefix and the turn would
  run against a compressed version of its own prompt;
- contributors run **last** because they key off `turn.turnRequest`, which does
  not exist until the drain.

`RunResult.outcome` is set by the loop and by it alone:

| Outcome | Set by | Meaning |
|---|---|---|
| `satisfied` | `settle` / `finalizeReported("success")` | accepted |
| `awaiting-input` | `settle` | ended on a clarification question — **no work done**, so headless can't read it as success. *Reachable only through an injected `TurnPolicies.completion`: none of the three built-in policies returns it today.* |
| `capped` | `capped()` | hit `maxIterations` without a final answer |
| `budget-capped` | `budgetCapped()` | a token ceiling cancelled the turn (§8) |
| `failed` | `fail()` / `finalizeReported("fail")` | judged unrecoverable |

The epilogue's `evaluation` is deliberately **separate from** `outcome`: the
judge annotates and reports, it never overrides what the loop already decided
([turn-loop.ts:180](src/agent/src/agent/runners/turn-loop.ts#L180)).

---

## 7. Summarizer & compaction

Compaction is the **one conversation-level rewrite** in the system, and it
happens at exactly one point: prologue step 2, before the request is drained.

**`SummarizeCompaction.applyIfNeeded`**
([summarize-compaction.ts:12](src/agent/src/agent/runners/policies/summarize-compaction.ts#L12)):

```
history().length <= orchestration.summarizeAtMessages?  → return (nothing to do)

tailStart = findCleanTailStart(history, summarizerKeepLastN)
  └─ walks FORWARD from the desired cut point to the first message that can
     legally HEAD a provider contents array — a user turn, or a non-tool-call
     assistant turn — skipping orphan tool results and tool-call turns that
     providers reject. Returns 0 → nothing safe to cut, return.

prefix = history[0..tailStart)        tail = history[tailStart..]
publish summarization-start
summaryText = new Summarizer(ctx.runtime).summarize(prefix, { signal })
  └─ throws?  → publish warning, RETURN — fails OPEN, a flaky summarizer
                never blocks the turn
turn.replaceHistory([ buildSummaryMessage(summaryText, prefix.length), ...tail ])
  └─ conversation.replaceAll() + seedOpeningSet()  ← the rewrite
publish summarization { summarizedCount, keptCount, summaryChars }
```

**`Summarizer`** ([summarizer.ts:14](src/agent/src/agent/runners/summarizer.ts#L14))
is a pure text-in / text-out **role**, not a special case:

- its own provider, resolved via `modelsRegistry.getProviderForRole("summarizer")`;
- its own hashed context snapshot — `session.contextHashes["summarizer"]` →
  `contextLoader.getContextSnapshot(hash)`, the same single-source rule every
  other role obeys;
- no tools, `temperature` 0.2 by default;
- the transcript is flattened by `formatMessageForSummary`, which keeps tool
  calls visible as `name(args…)` with args truncated at 200 chars.

**The summary message is a contract, not prose**
([summarizer.ts:52](src/agent/src/agent/runners/summarizer.ts#L52)):

- `SUMMARY_TAG` = `[CONVERSATION SUMMARY]` is a **stable machine-detectable
  prefix**, and `isSummaryMessage()` is its one consumer: `AgentRuntime.compact()`
  skips when the transcript is already a single summary
  ([agent-runtime.ts:357](src/agent/src/agent/runtime/agent-runtime.ts#L357)).
  Do not reword the tag. *(The comment above `isSummaryMessage` says "session
  reset uses this to preserve the latest summary" — that is stale; `reset()`
  does not call it.)*
- The body explicitly states the work **already happened**, so a resumed
  session continues rather than re-executing it.

Why the last K messages stay verbatim: recent tool results must stay precise
(paths, ids, diffs). The summary compresses the *prefix* only.

### Two summarization paths, not one

| Path | Trigger | Keeps a tail? |
|---|---|---|
| `SummarizeCompaction` (in-turn) | automatic, `history > summarizeAtMessages`, at prologue step 2 | **yes** — last `summarizerKeepLastN`, cut at a clean boundary |
| `AgentRuntime.compact()` | explicit host call (the REPL's `/compact`) | **no** — collapses the WHOLE transcript to one summary message |

`compact()` is not a policy and does not go through the loop: it calls
`stopAllWork()` + `awaitIdle()` first so the summarizer reads a quiescent
transcript, then `conversation.replaceAll([summary])`
([agent-runtime.ts:348](src/agent/src/agent/runtime/agent-runtime.ts#L348)).
Both paths share the same `Summarizer` and the same `buildSummaryMessage`
envelope.

---

## 8. Cancellation & quiescence

Three granularities on the runner:

| Call | Effect |
|---|---|
| `cancel(turnId)` | Aborts that turn if it is the live one; `false` for an unknown/settled id. There is no pending queue to remove from. |
| `cancelCurrent()` | The host's "stop" affordance — aborts whatever is in flight. |
| `cancelAll()` | Drops the queued wake (`pending = false`) **and** aborts the running turn. |

`AgentRuntime.stopAllWork()` is the composite the hosts actually call
([agent-runtime.ts:256](src/agent/src/agent/runtime/agent-runtime.ts#L256)):
sweep child sessions → `cancelAll()` → **`inbox.clear()`**. That last step
matters under one-prompt-per-turn: later prompts sit in the inbox and would
auto-run after the user cancelled, so a stop must truly stop.

For operations that need true quiescence — `reset()`, `compact()`, `shutdown()`
— cancel alone is not enough: aborts fire synchronously, the turn unwinds
*asynchronously*. `awaitIdle()` resolves once nothing is running, no wake is
pending, and **the inbox is empty** — that third term is why it waits through a
multi-prompt drain instead of resolving between two turns
([turn-runner.ts:136](src/agent/src/agent/runners/turn-runner.ts#L136)). The
runtime's pattern is always:

```ts
this.stopAllWork();              // children first, then cancelAll(), then inbox.clear()
await this.turnRunner?.awaitIdle();
// …now safe to clear/rebuild
```

Children are swept first because a dying child would otherwise push a report
into the very inbox being flushed. `shutdown()` unhooks the wake subscription
**before** anything else for the same reason
([agent-runtime.ts:279](src/agent/src/agent/runtime/agent-runtime.ts#L279)).

`stop()` (graceful) is different from cancellation: the in-flight turn finishes,
and **queued prompts stay in the inbox** so they survive for a resume.

### A budget breach is a cancel, not a race

The turn's signal is not only the host's stop handle. `beginTurn` wraps the
dispatch signal in a `CancellationToken` and exposes it as `ctx.cutoff`, so a
unit that must **end** the turn cancels that scope instead of throwing — and the
whole downward chain (the live model call, its tools, any child runtime)
collapses with it. Token ceilings are the first user
([turn-counter-middleware.ts](src/agent/src/agent/runners/middleware/turn-counter-middleware.ts)):
it already subscribes to every usage fold, so enforcement needed no new hook.

What makes this readable rather than ambiguous is the cancel **reason**.
`CancellationToken.cancel(reason)` forwards to `AbortController.abort(reason)`,
and `signal.reason` survives the `AbortSignal.any` merge — so the loop can tell a
policy stop from a user stop:

| Signal state | Outcome |
|---|---|
| aborted, reason `{ kind: "budget-exceeded" }` | `budget-capped` — settled, persisted, epilogue skipped |
| aborted, any other reason | `cancelled` — the turn throws and unwinds |

The loop checks the reason in **two** places, because a breach can surface either
way: the between-iteration abort check, and a `catch` around `iterate()` for a
breach that lands mid-`provider.chat` or mid-tool-call.

---

## 9. How the runtime wires it

The loop is **opt-in per host**
([agent-runtime.ts:231](src/agent/src/agent/runtime/agent-runtime.ts#L231)):

- **REPL** calls `startTurnLoop()` once; user input goes through
  `runtime.injectInput(input, "user")`
  ([repl.ts:107](src/agent/src/cli/repl.ts#L107)) — i.e. straight into the
  inbox. The prompt stays live during a turn, so a follow-up typed mid-run is
  queued and runs as the next turn.
- **Headless single runs** (and sub-agent child runtimes) never start the loop —
  they keep the direct `dispatchAsync(input, …)` path. That is why the
  running-status backstop still exists.

`startTurnLoop` binds a **contentless** `TurnDispatch` — `dispatchAsync('')`,
because the dispatch drains the inbox itself — plus `parentSignal` (the
runtime's cancellation scope, so a runtime cancel reaches turns without
enumeration) and `shouldRun` (the inbox predicate).

`rewireInboxWake()` then makes the one binding it still needs, and is called from
**both** `startTurnLoop` and `build()`
([agent-runtime.ts:309](src/agent/src/agent/runtime/agent-runtime.ts#L309)):

```ts
this.inbox.setOnPush((source) => this.turnRunner?.wake(source as TurnSource | undefined));
```

Any push un-parks the pump. The double call site is load-bearing: `reset()`
re-runs `build()`, constructing a **new** inbox — an active loop's subscription
would otherwise point at the dead one.

*(This method had a second binding —
`sessionManager.onNotification(… "subsession")` — routing a detached child's
report back in as a fresh turn. Detached sub-sessions are gone; an agent's answer
is now a tool result inside the turn that asked for it, so no self-wake path
remains.)*

---

## 10. Observability

**Runner events** ([turn-runner.ts:23](src/agent/src/agent/runners/turn-runner.ts#L23)):
`turn-start` and `turn-done` only — each carrying `turnId`, `source`, and (on
done) `status`. A throwing listener is swallowed so it cannot break the pump.

The CLI's rendering policy — `formatTurnEvent`
([render.ts:137](src/agent/src/cli/render.ts#L137)) — is deliberately quiet for
plain user turns (the prompt/spinner flow already narrates those); only
out-of-band activity gets a line:

- `turn-start` with `source !== "user"` → `(auto-wake: processing … report)`,
  answering "why is the agent talking unprompted?". With `"subsession"` gone,
  `"api"` is the only source that can reach this branch today;
- `turn-done` with `status === "error"` — which must surface here or nowhere,
  because the REPL no longer awaits a turn's settle (the prompt stays live);
- `turn-done` with `status === "cancelled"` → `(turn cancelled)`.

**Loop events** are a separate, much richer stream on the per-turn `Eventing`
bus (`OrchestratorEventTypes`: `START`, `ITERATION`, `MESSAGE_DELTA`, `MESSAGE`,
`TOOL_RESULT`, `SUMMARIZATION_START/SUMMARIZATION`, `RECALL_START/RECALL_FINALIZE`,
`EVALUATION_START/EVALUATION_VERDICT`, `WARNING`, `SYSTEM_FAILURE`). The turn bus
is chained under the runtime's, so everything bubbles to the host without an
`onEvent` callback ([agent-runtime.ts:86](src/agent/src/agent/runtime/agent-runtime.ts#L86)).

**Persistence today** is at the *conversation* level, not the scheduler level:
`Turn.runToolCalls` flushes after each iteration's tool results so a crash
mid-turn loses at most the iteration in flight, and `AgentRuntime.finalize()`
([agent-runtime.ts:315](src/agent/src/agent/runtime/agent-runtime.ts#L315)) runs
in a `finally` on every `dispatchAsync` exit path
([agent-runtime.ts:215](src/agent/src/agent/runtime/agent-runtime.ts#L215)). The scheduler itself holds no durable
state — the queue is the inbox, and the inbox is in-memory.

---

## 11. Scaling: durable turns (future consideration)

Not built — a direction, and one the contentless refactor made *simpler*, not
harder. The split is now cleanly along the file boundary:

| Half | What it is | Where it can live |
|---|---|---|
| Queue | `InputInbox` — prompts keyed by `sessionId`, plain strings | durable store (DB / log) |
| Live | `TurnRunner` + `TurnLoop`: pump, abort plumbing, iteration loop | in-memory, on the owning process, always |

**The store owns a prompt until it is claimed; the in-memory runner owns the
turn from claim to settle.** Because the runner is contentless, durability is a
swap of the *inbox* endpoints only — `push` → insert, `dequeue` → an atomic
claim, plus a terminal-row write when the turn settles. The pump and the loop
are untouched, because they were always about the live half.

**Why it shards cleanly.** The session is already the consistency boundary —
zero cross-session transactions — so `sessionId` is the shard key: disjoint
sets, no cross-shard joins, no distributed transactions. The inbox is already
keyed by exactly that. The contended global work-queue never forms, because
ownership is per-session and a single session is serial by construction.
Throughput is bound by LLM dispatch (seconds–minutes per turn), never by the
queue.

**Steady state never polls.** The owning process holds the session live and
`push` kicks the in-memory pump (write-through to the store for durability); the
claim query runs only on the cold paths — **placement** (first prompt for a
session lands somewhere) and **failover** (a process dies, another claims its
sessions):

```sql
UPDATE turns SET runtime_id = :rid, status = 'running'
WHERE turn_id = (
  SELECT turn_id FROM turns
  WHERE runtime_id IS NULL AND session_id = :sid AND status = 'pending'
  ORDER BY created_at LIMIT 1
  FOR UPDATE SKIP LOCKED
) RETURNING turn_id;
```

The `runtime_id` column **is** the ownership lease / fencing token: it enforces
single-writer-per-session once the in-process "one pump per runner" convention
no longer spans the cluster. A routing directory (`sessionId → process`) is an
optimization; the lease is the safety mechanism.

**The seam to build:** an inbox interface (`claimNext` / `append` / `settle`)
that `InputInbox` implements today and a durable backend implements later —
keeping `build-runtime.ts` host-agnostic (CLI injects in-memory, a cloud host
injects the durable store). The substrate is an ops choice, not a throughput
one: sharded Postgres (`UPDATE … RETURNING`), Kafka (`key = sessionId` → one
consumer per partition = the lease for free), or a Durable-Object / virtual-actor
grain (the object *is* the single-writer — collapsing directory + lease + live
runner into one primitive). Iteration-granular checkpointing already half-exists
via `Turn.runToolCalls`'s per-iteration flush. The real risk at scale is not the queue
but **failover storms** — a dead process dumping thousands of claims at once —
mitigated by leased TTLs that stagger reclamation.

---

## 12. Invariants (the contract in one list)

1. Exactly one pump per session ever calls `dispatchAsync`; producers only ever
   push to the inbox and `wake()`.
2. The runner is **contentless** — prompt text lives in the inbox, never in a
   turn record.
3. **One prompt per turn.** The drained request carries across every iteration;
   a prompt queued mid-turn runs as the next turn.
4. A wake whose content was already drained must not run a turn — enforced
   twice, by `shouldRun` in the pump and by `hasPending` in `TurnLoop.run`.
5. An aborted turn is `cancelled`, never `error`; a user stop must not render or
   persist as broken. The one exception is carried by the cancel **reason**: a
   `budget-exceeded` cancel settles as `budget-capped`, not `cancelled`.
6. A unit that must end a turn cancels `ctx.cutoff`; it never mints a fresh root
   signal and never races a timer against the work.
7. `TurnLoop` holds control flow only; `Turn` records and settles; `ModelCaller`
   and `Turn.runToolCalls` decide nothing. Only the `CompletionPolicy` (or a
   landed `report_result`, or the cap) ends a turn.
8. Prologue order is load-bearing: context → compaction → request drain →
   contributors.
9. Compaction and the evaluator pass both **fail open** — a flaky summarizer or
   judge never blocks or fails a turn.
10. The epilogue's `evaluation` annotates; it never changes `outcome`.
11. `maxIterations` comes from the role's `TurnProfile`, never from a branch on
    the role name.
12. Reset/compact/shutdown require `stopAllWork()` **and** `awaitIdle()` — abort
    is synchronous, unwinding is not, and `awaitIdle` also waits out queued
    prompts.
13. Headless hosts may bypass the loop entirely; the `running`-status guard in
    `dispatchAsync` is their (and the loop's) backstop.
