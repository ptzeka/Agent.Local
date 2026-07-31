# Production Backlog — Agent.Local
# AI MANAGED NO MANUAL CHANGE
# AI PLS FOLLOW EXISTING FORMAT

*Companion to [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md). Granular,
sequenced for one developer. Estimates are focused solo time (d = day).
Check items off here; each task lists concrete sub-steps and a "done when"
acceptance check so progress is verifiable, not vibes.*

Completed items are moved to [BACKLOG.DONE.md](BACKLOG.DONE.md) so this file
shows only open work.

Conventions used below:
- **Gate** = the deny-by-default tool check built in M0-1; later milestones
  extend it rather than adding new chokepoints.
- File refs are to `src/agent/src/...` unless noted.
- **Provenance** — when an item is completed and moved to BACKLOG.DONE.md, stamp
  it with a line: `_created <date> · updated <date> · by <git user>_` (created =
  when it first entered the backlog; updated = when last changed/marked done).

---

## M0 — Close the holes (≈ 1.5–2 weeks)

Everything here is independent of the future user-keyed store and survives it.

### M0-1 · Dispatch-time tool gate — `~1.5d` · P0
> **Superseded by MR-1/MR-2 + reframed** (see milestone MR below and
> [UNIFIED_RUNTIME_PLAN.md](UNIFIED_RUNTIME_PLAN.md)).
>
> **Reframe (2026-06-16):** tool-level access is already structural — the
> read/write server split (`fsmcp` vs `fsmcp-readonly`, `excelmcp` vs
> `excelmcp-readonly`) means a server is either mounted for a role or not;
> there is no need for a per-tool deny list on top. The real gate is
> **user-role → server access**: which MCP servers a user is allowed to reach,
> computed as model whitelist ∩ user policy (`resolveAllowedTools` in MR-1,
> policy source in M2-3/M2-4). Currently all sessions run as anonymous so
> model whitelist = effective set. Denial at dispatch is structural (unmounted
> servers are unreachable), not a runtime deny list.

**Done when:** M2-4 lands — a user with a restricted role is denied a server
that the model whitelist would otherwise allow, enforced at mount time.

### M0-2 · Spawned-server env allowlist + provider-key scrub — `~0.5d` · P0
- [ ] Extract `buildServerEnv(config)` from `spawnServer`
      (`registries/mcp-registry.ts` ~L200): forward only `PATH`, `HOME`,
      `TMPDIR`, `AGENT_WORKSPACE`, plus the server's own `env` block from
      `mcp.json`. Nothing else from `process.env`.
- [ ] In CLI bootstrap (`cli/index.ts` ~L106): after `ModelRegistry.load()`
      returns, `delete process.env.ANTHROPIC_API_KEY` / `GEMINI_API_KEY`
      (SDK clients already hold them).
- [ ] Unit-test `buildServerEnv`: provider keys absent, declared `env` keys
      present, `AGENT_WORKSPACE` always set.

**Done when:** test asserts a spawned server's env contains no provider keys.

### M0-3 · Symlink-safe workspace guard — `~0.5d` · P1
- [ ] In `synthetic-mcp/fs-tools/workspace.ts` `resolveSafe`: resolve the
      nearest *existing* ancestor of the candidate via `fs.realpathSync`,
      re-join the non-existing tail, then do the prefix check against the
      realpath'd root.
- [ ] Tests: symlink inside workspace → outside target is refused for read
      and write; legitimate nested dirs still resolve; non-existent target
      file (about to be created) still works.

**Done when:** the symlink-escape test is red on the old code, green on new.

### M0-4 · Repo hygiene — `~0.5d` · P1
- [ ] `.gitignore`: `src/agent/sessions/`, `src/agent/contexts/`,
      `src/agent/workspace/`, `.env`. `git rm --cached` the tracked ones.
- [ ] Add `.env.example` (`OLLAMA_HOST`, `AGENT_WORKSPACE`,
      `AGENT_SESSIONS_DIR`, `ANTHROPIC_API_KEY=`, `GEMINI_API_KEY=`,
      `AGENT_API_TOKEN=`) — README already tells users to copy it.
- [ ] `mcp.json`: resolve server `command`/`args` paths relative to the
      config file's directory; replace the absolute `/Applications/www/...`
      entry with a relative one.
- [ ] History purge of committed session JSON: optional, log as nice-to-have
      (solo repo, low urgency).

### M0-5 · CI + lint — `~1d` · P1
- [ ] GitHub Actions workflow: `npm ci` → `npm run build --workspaces` →
      `tsc --noEmit` (agent) → `jest` (agent) → `npm audit --audit-level=high`.
- [ ] Adopt Biome (single tool, fast, no config sprawl — good solo choice)
      or eslint+prettier; wire into CI and a `npm run lint` script.
- [ ] Verify the `xlsx` advisory situation; if unpatched on npm, swap to the
      SheetJS CDN build or `exceljs` (only `synthetic-mcp/excel-tools`
      touches it).

**Done when:** a PR that breaks a test or lint fails CI.

### M0-6 · Graceful interrupt — `~1d` · P1
- [ ] `cli/index.ts`: create an `AbortController` per dispatch; first
      SIGINT → `controller.abort()` and let `dispatchAsync`'s `finally`
      persist; second SIGINT → force exit. SIGTERM same as first.
- [ ] Verify abort propagates: provider calls, evaluator, summarizer, and
      executor all already accept `signal` — confirm each actually passes it
      to the SDK call (Anthropic/Gemini/Ollama support request abort).
- [ ] REPL: Ctrl+C during a turn cancels the turn, not the process
      (matches user expectation from other CLIs).

**Done when:** Ctrl+C mid-turn leaves a persisted session with status
`error` (or a new `aborted` status) and the process exits cleanly.

### M0-7 · README refresh — `~0.5d` · P2
- [ ] Remove "no cloud calls / Ollama only" claims; document the three
      providers and required env keys.
- [ ] Replace the planner/coder description with the
      orchestrator → dispatch_executor → evaluator flow.
- [ ] Document headless mode, exit codes, and session resume.

---

## M1 — Loop reliability & cost (≈ 1–1.5 weeks)

### M1-2 · Complete token accounting — `~1d` · P1
- [ ] `Executor`, `Evaluator`, `Summarizer` call `provider.chat` directly —
      fold their `usage` into `session.counters` via the existing
      `accumulateUsage` (export it from a shared module).
- [ ] Add a per-role breakdown (`counters.byRole: Record<string, {in, out}>`)
      so cost attribution survives the move to budgets.
- [ ] Fold usage on the FAILURE path too: today `foldCounters`
      (`runners/orchestrator.ts` ~L266) runs only after a successful chat, so a
      turn that streams output then throws records zero spend — exactly the case
      we most want costed. Capture partial usage in the provider's catch (or a
      `finally`) and fold it before re-throw.
- [ ] Update the code comment in `session/session.ts` that documents the gap.

### M1-3 · Budget ceilings — token spend cancels the turn — `~1d` · P1
> **Reframed (2026-07-30):** the original wording predates both the
> `MetricsRegistry` and the runner refactor, and pointed at a
> `runners/orchestrator.ts` that no longer exists. The accounting half is now
> **done** — `TurnCounterMiddleware` folds own spend (`orchestrator-message`)
> and delegated subtree spend (`tool-result`) into `MetricsRegistry`, whose
> tally is seeded from the store and therefore already spans restarts
> ([metrics-registry.ts:22](src/agent/src/agent/runtime/metrics/metrics-registry.ts#L22)).
> What is missing is only the **ceiling and the stop**.

The tally is read by nobody. A runaway turn (or a dispatch subtree that fans
out) burns budget until `maxIterations` trips, which is an *iteration* bound,
not a *cost* bound — a single turn with huge context can cost 50× another turn
with the same iteration count.

**Mechanism: a breach is a cancel, not a race** (per the cancellation rule in
[AGENTS.MD](AGENTS.MD) — never race promises for a deadline; cancel the scope
and let it collapse downward). The turn already has exactly the right seam:
one signal minted per dispatch and threaded down.

- [x] `orchestration` config: `maxTokensPerTurn`, `maxTokensPerSession`
      (0 = unlimited, the default, so existing configs are unaffected).
- [x] `AgentRuntime.beginTurn` ([agent-runtime.ts:160](src/agent/src/agent/runtime/agent-runtime.ts#L160))
      wraps the incoming dispatch signal in a `CancellationToken`
      (`@agent-local/common/lifetime`) and puts `token.signal` on the
      `RunnerContext`. **Wrap, never replace** — cancelling cuts this turn and
      everything below it (tool calls, child runtimes), never the parent.
- [x] Enforce in `TurnCounterMiddleware`
      ([turn-counter-middleware.ts](src/agent/src/agent/runners/middleware/turn-counter-middleware.ts))
      — it is already the one subscriber that sees every usage fold, so the
      check is three lines in the existing handler and needs **no new hook**:
      after each `recordOwnUsage`/`recordDelegatedUsage`, compare
      `metrics.totals()` against the two ceilings; on breach
      `token.cancel(BUDGET_EXCEEDED)`.
- [x] Distinguish the cancel from a user stop. `CancellationToken.cancel(reason)`
      forwards to `AbortController.abort(reason)`, so the reason survives on
      `signal.reason` even through the `AbortSignal.any` chain. `TurnLoop.iterate`
      ([turn-loop.ts:101](src/agent/src/agent/runners/turn-loop.ts#L101)) and
      `ToolCaller.run` currently throw a flat `"turn aborted: user requested stop"`
      — branch on the reason and return a `budget-capped` result instead of
      throwing, mirroring the `capped()` path
      ([turn-loop.ts:181](src/agent/src/agent/runners/turn-loop.ts#L181)).
- [x] Add `"budget-capped"` to the `RunResult.outcome` union
      ([turn-loop.ts:29](src/agent/src/agent/runners/turn-loop.ts#L29)); it is an
      *error* outcome like `capped` (session status `error`, not `awaiting-input`)
      so a headless job cannot bank a half-finished turn as success. Extend the
      `cli/index.ts` exit codes.
- [x] Per-session ceiling must be checked against the **seeded** tally, not the
      turn delta — that is what makes it survive a restart. Per-turn ceiling
      needs a turn-start baseline (`totals()` snapshot in the middleware's
      pre-hook), since the registry is cumulative.
- [x] Surface the breach: a `WARNING`-class event carrying which ceiling tripped
      and the totals, so the CLI can say *why* the turn stopped rather than
      showing a bare cancel.
- [x] Tests: (a) tiny `maxTokensPerTurn` + fake provider → outcome
      `budget-capped`, transcript persisted, no throw; (b) a breach mid-tool-call
      aborts the in-flight tool via the same signal; (c) a **user** cancel still
      reports `cancelled`, not `budget-capped` (the reason-branch is not
      swallowing user stops); (d) session ceiling trips on a resumed session
      whose spend was seeded from the store.

**Done when:** ~~…~~ — **met 2026-07-31**: a breach cancels the turn's cutoff with
a `{ kind: "budget-exceeded" }` reason, the loop settles `budget-capped` instead of
throwing, and a user stop in the same code path still reports `cancelled`. Covered by
[budget.test.ts](src/agent/tests/runners/budget.test.ts) (9) plus 3 loop-level tests in
[turn-loop.test.ts](src/agent/tests/runners/turn-loop.test.ts). Agent suite green
(292 tests).

> **Implementation notes.** The decision lives in a pure
> [budget.ts](src/agent/src/agent/runners/policies/budget.ts) (`ceilingBreach` /
> `totalSpend` / `budgetCancelDetail`); the *enforcement* is ~6 lines inside the
> existing `TurnCounterMiddleware` subscription, so there is still exactly one
> subscriber folding usage. `RunnerContext` gained `cutoff?: CancellationToken`,
> minted in `beginTurn` — the seam any future unit uses to stop a turn without
> throwing. The loop reads the cancel reason in TWO places: the between-iteration
> abort check, and a `catch` around `iterate()` (a breach mid-`provider.chat` or
> mid-tool-call surfaces as a throw, not as the check). The epilogue is skipped on a
> budget stop — the evaluator pass is another model call, which is what the ceiling
> forbids.

### M1-4 · Prompt-cache strategy — `~1.5d` · P1
Today: Anthropic caches system+tools only (one breakpoint); Gemini caches
system+tools explicitly with an unhandled 5-min expiry; the growing
conversation — the expensive part of an agentic turn — is never cached.
- [ ] Determinism: sort tool descriptors by name at the provider boundary
      (moves into the ToolPort with MR); rule: nothing volatile (timestamps,
      ids) in system messages — project context + static prompts only.
- [ ] Tripwire: WARNING event when an Anthropic call at iteration ≥2 of a
      turn reports `cache_read_input_tokens == 0` — converts silent cache
      regressions into visible events. Log when a role's `contextHash`
      changes (known cold-cache cause).
- [ ] Keep 5-min ephemeral TTL (interactive cadence + sub-session poll
      backoff fit inside it); skip evaluator/summarizer tuning (cheap models;
      Haiku's 4096-token minimum prefix means small judge prompts don't cache).

**Done when:** a mocked 3-iteration turn shows breakpoints on system + last
block + lookback block, and session counters show cache reads ≥ prior-prompt
size from iteration 2 onward in a live smoke test.

### M1-5 · Evaluator fail-open visibility — `~0.5d` · P2
- [ ] New event type `EVALUATION_FAILED_OPEN` (today it's a generic WARNING
      in `runners/orchestrator.ts` ~L443) + a session counter, so a dead
      judge is observable instead of silent leniency.

### M1-6 · MCP client resilience — `~1d` · P2
> **Folded into M1-14** (2026-07-30): the reconnect below becomes the breaker's
> half-open probe. Keep the sub-steps as the implementation detail; do not build
> a second retry path beside the port policy.
- [ ] Detect transport death in `McpClient` (closed/error event from the
      SDK client); mark disconnected.
- [ ] One lazy reconnect attempt on next `callTool` for stdio servers
      (respawn via stored config); on failure return the existing
      "no longer connected" error.
- [ ] Test with a server process that exits mid-session.

### M1-7 · Tool-call execution isolation in the loop — `~0.5d` · P1
> **Folded into M1-14** (2026-07-30): "never throw out of the tool port" is the
> policy's degrade rule. The file refs below are stale — the call site moved to
> [tool-caller.ts:21](src/agent/src/agent/runners/tool-caller.ts#L21).
The per-server `McpClient.callTool` already catches and returns `isError`
(`mcp/mcp-client.ts` ~L107), but the orchestrator's `scopedClient.callTool`
call (`runners/orchestrator.ts` ~L339) runs bare. A throw from the routing /
scoping layer (server unmounted, transport died mid-turn) escapes the loop and
kills the whole turn instead of degrading to a tool result the model can react to.
- [ ] Wrap each `callTool` in the tool-loop in try/catch; on throw, push a
      `wrapToolResult(call, "[tool-error] …")` message and continue the loop.
- [ ] Test: a tool that throws (not returns `isError`) becomes a tool-error
      message and the turn keeps going to a final answer.

### M1-8 · Context-overflow recovery — `~1d` · P1
`maybeSummarize` fails *open* (`runners/orchestrator.ts` ~L433): if
summarization errors, the next `provider.chat` ships an over-window transcript
and throws a context-length error (non-retryable — M1-1 won't catch it), killing
the turn with no recovery.
- [ ] Classify context-length errors at the provider boundary distinctly from
      other fatals.
- [ ] On that error, force a hard re-summarize/truncate of the working messages
      and retry the chat ONCE before surfacing failure.
- [ ] Test with a fake provider that rejects oversize input then succeeds:
      the loop recovers instead of ending the turn.

### M1-9 · Stagnation / loop detection — `~1d` · P2
The only no-progress guard is the periodic evaluator (`runners/orchestrator.ts`
~L359), which is coarse and costs a judge call. A model repeating the same tool
call with the same args, or oscillating between two states, just burns iterations
to the cap.
- [ ] Hash `(tool name + canonical args)` per call; on N identical consecutive
      calls, break with a new outcome (or inject a single corrective nudge then
      escalate to the evaluator).
- [ ] Cheap structural check runs every round; the evaluator stays the
      semantic backstop.
- [ ] Test: a fake model emitting one repeated call stops before `maxIterations`.

### M1-10 · Parallel independent tool execution — `~1d` · P2
Tool calls in one assistant turn run serially (`runners/orchestrator.ts` ~L334).
- [ ] Run independent calls concurrently (`Promise.all`), preserving result
      order and honoring the turn signal; keep writes serialized if any
      ordering hazard exists (start read-only-only).
- [ ] Test: two read calls overlap in time; results map back to the right ids.

### M1-11a · Event-routed assistant message (atomic baseline) — `~0.25d` · P2
Groundwork for streaming: confirm the assistant message reaches the UI **only**
through the event bus, atomically (collect-then-emit one event), with persistence
decoupled — no per-delta flush yet. This is largely **already true** in code; the
story is to verify, lock it with a test, and add the gating scaffolding M1-11b
will flip.

**Current state (already event-routed).** The orchestrator collects the response
and publishes one `MESSAGE` event ([orchestrator.ts:209-214](src/agent/src/agent/runners/orchestrator.ts#L209-L214)),
then `conversation.append(assistantMessage)` (L216). The repl subscribes only to
the bus ([repl.ts:45](src/agent/src/cli/repl.ts#L45)) and renders via `formatEvent`
→ `case "orchestrator-message"` ([render.ts:25-27](src/agent/src/cli/render.ts#L25-L27)).
No hard wire from provider to UI; the provider still `finalMessage()`-collects
internally ([anthropic-provider.ts:75](src/agent/src/agent/providers/anthropic-provider.ts#L75)).
- [ ] Verify no non-event path renders assistant text (grep the CLI for direct
      writes of `assistantMessage`/response content outside `formatEvent`).
- [ ] Add a `streamOutput` feature flag (M6-1), default **off** → collect-only
      atomic emit stays the behaviour for every mode. Mode from the runtime, flag
      value from the registry — no `if (isCli)` in the provider.
- [ ] Test: a turn emits exactly one `MESSAGE` event whose content equals the
      persisted `append`ed message (atomic, byte-identical) — the contract M1-11b
      must preserve.

**Done when:** assistant text reaches the UI solely via the `MESSAGE` event,
collect-then-emit; `streamOutput` exists and is off; transcript `append`/`flush`
unchanged; a test pins one-event-per-message equal to the persisted content.

### M1-11b · Stream assistant deltas to the UI — `~0.75d` · P2
Flip M1-11a's atomic emit to a live token stream. The Anthropic provider already
streams internally to dodge the SDK HTTP timeout but only returns `finalMessage()`,
so a long generation looks hung. Add **one** event type to the bus M1-11a proved
out — nothing structural changes.

**Architecture.** Only the assistant *text* (generated token-by-token) needs a
*delta* stream; atomic `TOOL_CALL`/`TOOL_RESULT` are untouched. Streaming and
persistence stay fully decoupled: deltas are fire-and-forget to the UI while the
buffer accumulates; on the terminal event the collected message is the final
message and is `append`ed once (the M1-11a contract). The orchestrator ensures the
**store** flush and forgets the UI entirely (`Conversation.append`/`flush`
unchanged — UI is never a `Conversation` concern; Repository only calls downward).

**Message-stream lifecycle (distinct from the turn lifecycle).** `turn-start`/
`turn-done` stay the *work* boundary (they span tool calls + multiple messages and
gate the spinner — [repl.ts:52-54](src/agent/src/cli/repl.ts#L52-L54)); they are
NOT touched. Inside a turn, one new event frames each chat:
`CHAT_START` → `MESSAGE_DELTA × N` → `MESSAGE` (existing, reused as the stop).
`CHAT_START` is the `[orchestrator]` marker: print the prefix once, switch the
renderer into incremental mode. It can fire **multiple times per turn** (one per
streamed assistant message across iterations). **Invariant: one chat stream at a
time** — the single turn-runner pump already serialises iterations, so streams
never interleave; the renderer assumes at most one open `CHAT_START` before its
`MESSAGE` stop and need not multiplex.
- [ ] Add `CHAT_START` + `MESSAGE_DELTA` to `OrchestratorEventTypes`
      ([runner-events.ts](src/agent/src/agent/runners/runner-events.ts)) — two
      enum entries; `MESSAGE` stays the terminal (no new stop event).
- [ ] `CHAT_START` carries the **emitter** in its payload (`{ emitter: string }`,
      e.g. `roleName` — kept open so it can be anything later: orchestrator,
      executor, a named sub-agent). The renderer prints `[${emitter}]` generically
      from that field — NOT from a hardcoded per-source branch like today's
      `[ORCHESTRATOR]`/`[EXECUTOR]` ([render.ts:27](src/agent/src/cli/render.ts#L27),
      [render.ts:70-71](src/agent/src/cli/render.ts#L70-L71)). Producer owns its
      identity; renderer just formats. Leave the existing atomic events' hardcoded
      labels untouched — only the new streaming entry point is data-driven.
- [ ] Provider emits `MESSAGE_DELTA` per text delta off the existing
      `this.client.messages.stream`; keep `finalMessage()` as the in-memory result
      so `append` stays byte-identical. Provider knows the bus, never the UI.
- [ ] `formatEvent` renders `MESSAGE_DELTA` incrementally (no newline per delta),
      composing with the spinner/prompt repaint per the horizontal-only render
      constraint (`\r` + clear-line; no scroll regions / absolute cursor moves).
- [ ] Reconcile double-render in the **UI layer only**: when deltas were streamed,
      suppress the terminal `MESSAGE` block render (deltas are the live copy).
      Orchestrator stays oblivious. Note one assistant message can fan out to
      `MESSAGE_DELTA × N` (text) + `TOOL_CALL × M` (tool_use) yet persist as one
      `append(finalMessage)`.
- [ ] Gate emission on `streamOutput` (from M1-11a) resolved by mode: interactive
      `chat` streams deltas; `standalone`/`api` stay collect-only (SSE callers opt
      in).

**Done when:** a long interactive turn paints tokens live via `MESSAGE_DELTA`; the
persisted transcript is byte-identical to the M1-11a baseline; tool_call/result
events and persistence are untouched; `standalone`/`api` still collect-only; the
provider holds no reference to the UI.

### M1-12 · Output token-limit continuation — `~0.5d` · P2
Don't break on *output* token-limit hits. When a response stops on `max_tokens`
the generation was cut off, not finished, but the loop takes the truncated
message as-is. (Input-side overflow is M1-8; this is the output side.)
- [ ] Detect `stop_reason: "max_tokens"` (Anthropic) / the Gemini equivalent at
      the provider boundary and expose it on `ChatResponse`.
- [ ] On a truncated stop, continue the generation (append the partial as an
      assistant turn and re-ask, or raise per-call `maxTokens`) before treating
      it as final — never let a cut-off response satisfy completion.
- [ ] Test: a fake provider returning a `max_tokens` stop then a clean finish
      yields one coherent assistant message, not a truncated turn.

### M1-14 · Resilience at the ports, not in the implementations — `~1.5d` · P1
Both outbound edges are already abstracted — `LLMProvider.chat` for models,
`ScopedToolClient.callTool` → `Mcp.callTool` for tools — but resilience is
**not** at either abstraction. It is scattered into the concrete
implementations, so every new provider or client re-earns it:

- M1-1 shipped `retryTransient` but wired it **inside each provider's `chat`**
  (its own divergence note in [BACKLOG.DONE.md](BACKLOG.DONE.md) records the
  decision). Anthropic and Gemini each remember to call it; Ollama and the next
  provider must remember too, and nothing enforces that.
- The tool edge has **nothing**. `McpClient.callTool` catches and returns
  `isError` per server, but a throw from the routing/scoping layer (server
  unmounted, transport died mid-turn) escapes and kills the whole turn (M1-7),
  and a dead stdio server is retried on every single iteration with no breaker
  (M1-6).

The point of abstracting the implementation is that the *policy* lives at the
port. This story makes resilience a property of the two ports and reduces
M1-6 / M1-7 to wiring under it.

- [x] One `ResiliencePolicy` — **landed in
      [resilience.ts](src/agent/src/agent/resilience.ts), not `@agent-local/common`**:
      both ports it serves live in `src/agent`, and promoting it to the sibling repo
      would have forced a cross-repo rebuild for zero present consumer. Move it when
      `src/mcp` actually needs it. `classify(error) → transient | terminal`,
      jittered backoff, attempt cap, and a per-key **circuit breaker** (open
      after N consecutive failures, half-open probe after a cooldown). Reuse
      `retryTransient`/`isTransientError`
      ([retry.ts](src/agent/src/agent/providers/retry.ts)) as its retry core —
      **extend it, do not write a second one**.
- [x] **Do not own the deadline.** Per-model tool timeouts already belong to the
      MCP servers via the chainable `Mcp.setTimeout`; the policy retries and
      breaks, it never starts a competing timer. A timeout arrives as a cancel
      on the turn signal and is therefore *terminal*, never retried.
- [x] **Model port.** Apply the policy once at the provider boundary
      (`providers/index.ts` composition) instead of inside each `chat`. The
      streaming carve-out is why M1-1 went in-provider — so the port passes a
      `shouldRetry` veto the implementation supplies (`hasStreamed` → never
      retry, tokens are already on screen). Policy at the port, one veto hook
      from the implementation; no provider re-implements backoff.
- [x] **Tool port.** `ScopedToolClient.callTool` becomes the resilience seam:
      never throws (a throw degrades to a `[tool-error]` result the model can
      react to — absorbs **M1-7**), retries transient transport failures, and
      trips a breaker keyed by **server name** so one dead server does not burn
      every iteration of the turn.
- [ ] **M1-6's respawn is NOT built** — the breaker's half-open slot exists and a
      recovered server closes it, but nothing yet detects stdio transport death or
      relaunches the process, so a dead server degrades to fast tool-errors rather
      than reconnecting. M1-6 stays open for exactly that sub-step.
- [x] **Breaker state is per runtime, not per turn**, so it survives across
      turns of a session — a server that died stays open until its cooldown
      rather than being re-probed by every new turn.
- [x] Honour the turn signal everywhere: no retry may start once
      `signal.aborted` (this is also what keeps M1-3's budget cancel from being
      absorbed by a backoff sleep).
- [x] Observability: a `WARNING`-class event per retry and per breaker
      transition, carrying the port, the key (provider/server), and the attempt
      — a silent retry loop looks identical to a slow model otherwise.
- [x] Tests: (a) a provider added with **no** retry code of its own still
      retries a 503 through the port; (b) a scoping-layer throw becomes a
      tool-error message and the turn reaches a final answer; (c) N consecutive
      failures open the breaker and the next call fails fast without a spawn
      attempt; (d) a half-open probe that succeeds closes it; (e) abort during
      backoff stops immediately and does not consume the remaining attempts.

**Done when:** ~~…~~ — **met 2026-07-31 except the respawn sub-step above**: a
`BareProvider` with zero resilience code retries a 503 through the port, a
scoping-layer throw becomes a tool-error the turn survives, and a dead key fails
fast on an open breaker. Covered by
[resilience.test.ts](src/agent/tests/resilience.test.ts) (13).

> **Implementation notes.** `retryTransient` from M1-1 is the policy's retry core
> (extended, not duplicated) and now walks the error's `cause` chain, because a port
> policy sees the provider's *wrapped* error and the SDK's numeric `.status` lives on
> the cause — both cloud providers pass `{ cause: err }` now. The streaming carve-out
> that kept M1-1 inside the providers is solved AT the port: `ResilientProvider` wraps
> the caller's `onDelta`, so it can see that tokens were emitted and veto the retry —
> which let the in-provider `retryTransient` calls be **removed** (they would otherwise
> have nested, giving 9 attempts). The breaker lives on `McpClientRegistry` /
> `ProvidersRegistry` so its state is per runtime, not per turn. Only *transient*
> failures count toward it: a 400 schema error is the caller's fault and must not open
> a breaker on a healthy dependency.

### M1-15 · Turn idempotency — has this request already run? — `~1d` · P2
Nothing in the system can tell whether a prompt it is about to run has already
been run. Today that is survivable because the inbox is in-memory and a crash
loses everything; it stops being survivable the moment either of the two paths
already on the roadmap lands:

- **Durable inbox** ([TURN_ROUND.md §11](TURN_ROUND.md)) — a claim that is
  written before the turn settles and then replayed after a failover runs the
  same request twice. Every mutation the turn performed (file writes, dispatched
  executor work) happens twice.
- **Session leases** (M3-3) — lease theft after a stale heartbeat is exactly the
  replay case: the old owner may still be mid-turn.

There is also a live, non-hypothetical case: the coalescing that used to fold N
child reports into one turn was removed with the round model, so N sub-sessions
settling now push N near-identical wake prompts, each of which becomes its own
turn.

- [x] **Request fingerprint.** `hash(sessionId + source + normalized content)`,
      computed in `InputInbox.push`
      ([input-inbox.ts:16](src/agent/src/agent/runners/input-inbox.ts#L16)) and
      carried alongside the prompt (the queue becomes
      `{ fingerprint, content, source }`, not a bare string).
- [x] **Enqueue-time dedup (cheap, immediate value).** Drop a push whose
      fingerprint is already *pending* in the same session's queue. This alone
      restores the coalescing the round model used to provide, for
      `source: "subsession"` reports.
- [x] **Executed-ledger (the real idempotency).** A small per-session ledger of
      `fingerprint → { turnId, outcome, finishedAt }`, written when the turn
      settles. `TurnLoop.run` consults it **after** `drainRequest`
      ([turn-loop.ts:169](src/agent/src/agent/runners/turn-loop.ts#L169)) — the
      first point where the request is actually known — and on a hit short-circuits
      to the recorded result instead of assembling a turn, exactly as
      `Turn.idle()` already short-circuits a cold wake
      ([turn-loop.ts:78](src/agent/src/agent/runners/turn-loop.ts#L78)).
- [x] **Scope it narrowly, or it is a bug factory.** A human legitimately types
      `yes`, `continue`, `again` repeatedly and MUST get a fresh turn each time.
      Default: dedup applies to `subsession` and `api` sources only, plus a short
      TTL window; `user` input is exempt unless an explicit idempotency key is
      supplied. Make the rule config, not a hardcoded branch.
- [x] **`api` source gets a real key** — the plumbing:
      `injectInput(content, source, idempotencyKey)` → `InputInbox.push` uses the key
      as the fingerprint material instead of the content hash, so a client can retry
      a POST with reworded content and still resolve to the same request.
- [ ] **No HTTP route supplies the key yet.** The one live producer
      ([runner.ts:85](src/agent/src/server/comms/runner.ts#L85)) still injects as
      `source: "user"` — deliberately unchanged, since retagging it `"api"` would
      switch on pending-duplicate dropping for a path with no coverage. Wiring an
      `Idempotency-Key` header (and the retag) is the remaining sub-step.
- [x] **Ledger lives with the inbox, not in the runner.** The runner stays
      contentless; when the inbox goes durable the ledger is the same swap (a
      row + a unique index on `(session_id, fingerprint)` — the DB enforces
      once-only rather than the application remembering to check).
- [x] Tests: (a) three identical subsession reports pushed while a turn runs
      produce ONE follow-up turn; (b) the same fingerprint replayed after its
      turn settled returns the recorded outcome and makes **no** model call;
      (c) a user typing `continue` twice gets two turns; (d) two different
      contents never collide; (e) an `api` push with the same idempotency key
      and different content is rejected as a conflict rather than silently
      running.

**Done when:** ~~…~~ — **met 2026-07-31 except the HTTP header wiring above**: a
replay returns the recorded outcome with zero model and zero tool calls, three
identical child reports collapse to one turn (and one wake), and a human retyping
`continue` still gets a fresh turn every time. Covered by
[input-inbox.test.ts](src/agent/tests/runners/input-inbox.test.ts) (13) plus 4
loop-level tests.

> **Implementation notes.** `InputInbox.dequeue` now returns an `InboxItem`
> (`{ content, fingerprint, source }`) rather than a bare string, which is what lets
> the settling turn record *what* it executed. The ledger check moved the pull to the
> TOP of `TurnLoop.run`, before `Turn.open` — a replay must not pay for tool mounting
> and server binding. The request is still *appended* inside the prologue, so the
> load-bearing context → compaction → append order is untouched. Two gates keep this
> from becoming a bug factory: pending-duplicate dropping applies only to
> `subsession`/`api`, and the executed ledger is **off by default**
> (`idempotencyTtlMs: 0`) — turning it on for `user` input would break a human
> retyping the same thing.

---

## M2 — Identity & policy (≈ 2 weeks) — *policy-as-artifact decided*

### M2-1 · Real JWT verification — `~1.5d` · P0
- [ ] Replace the mock in `runtime/middleware/identity.ts` with `jose`:
      `createRemoteJWKSet` + `jwtVerify`, validating signature, `iss`,
      `aud`, `exp`.
- [ ] Config: `AGENT_OIDC_ISSUER`, `AGENT_OIDC_AUDIENCE`, optional
      `AGENT_OIDC_JWKS_URL` override. Missing config + token present →
      auth `failed`, not silently anonymous.
- [ ] Keep the claim-mapping logic (sub/roles/scope) — it's already correct.
- [ ] Tests with a locally-generated key pair and a static JWKS: valid token,
      expired, wrong audience, bad signature, garbage.

### M2-2 · Session ownership binding — `~0.5d` · P0
- [ ] `runtime/middleware/session.ts`: on resume, refuse when
      `session.user?.sub` exists and ≠ `ctx.user.sub` (allow an
      `agent:admin` scope override). Legacy sessions without `user` →
      treat as anonymous-owned.
- [ ] Test: principal A cannot resume B's session; admin scope can.

### M2-3 · `policies.json` + PolicyRegistry — `~2d` · P0
- [ ] Schema (sibling of `models.json`):
      `roles: { <userRole>: { mcpServers: string[], denyTools?: string[], canDispatchExecutor: boolean, maxTokensPerSession?: number } }`
      plus `defaultRole` for authenticated-but-unmapped and `anonymous`.
- [ ] `PolicyRegistry.load()` mirroring `ModelRegistry.load()`; resolve a
      principal's effective policy from `claims.roles` (most-permissive-wins
      or explicit priority — pick one, document it).
- [ ] New `PolicyMiddleware` after `AnonymousMiddleware` stamping
      `ctx.policy`; pipeline fails closed if policies.json is missing in
      service mode (CLI dev mode may default to a permissive built-in).

### M2-4 · Enforce policy at the gate — `~1d` · P0
Tool-level granularity is via **server naming** (`fsmcp` vs `fsmcp-readonly`)
— no per-tool deny list is needed. The gate is user-role → server access:
which MCP servers a user may reach, computed as model whitelist ∩ user policy
and enforced at mount time (unmounted servers are structurally unreachable).
Currently all sessions run as anonymous so only the model whitelist applies;
user policy intersection activates once M2-1/M2-2/M2-3 land.
- [ ] Effective allowed **servers** = per-model `mcp` whitelist ∩ user-policy
      server allowlist. Compute in `resolveAllowedTools(modelRole, userPolicy,
      registry)` (built in MR-1); `McpRegistryMiddleware.mountServers` calls
      it instead of `getValidMcpServersForRole` alone — one artifact, can't
      drift between advertisement and enforcement.
- [ ] `canDispatchExecutor: false` → `executor` server neither mounted nor
      reachable; the executor sub-agent is unreachable for that user.
- [ ] Tests: a user policy that excludes `fsmcp` (write) gets only
      `fsmcp-readonly` mounted even when the model whitelist includes both;
      anonymous users fall through to model whitelist unchanged.

### M2-5 · Remote MCP servers with bearer auth — `~1.5d` · P1
Today `McpClientRegistry` speaks stdio only; anything beyond local testing
needs remote MCP servers over Streamable HTTP with an `Authorization: Bearer`
header per the MCP spec (OAuth 2.1 for remote servers).
- [ ] `mcp.json` schema: support `{"type": "http", "url": "...", "auth": {"type": "bearer", "tokenEnv": "MY_SERVER_TOKEN"}}`
      alongside the existing stdio entries. Token comes from a named env var
      (or, later, the M3 store) — never inline in the config file, which is
      committed.
- [ ] `registries/mcp-registry.ts`: connect via the MCP SDK's
      `StreamableHTTPClientTransport` with the bearer header when
      `type: "http"`; keep `spawnServer` for stdio. Both land in the same
      neutral TRANSPORT layer — the ToolPort gate above is unchanged.
- [ ] Treat remote servers as untrusted by default: their tools get no
      read-only classification for free; explicit per-server allowlist entry
      required (same rule as MR-1) before any tool is advertised.
- [ ] Never log the token; redact `auth` when echoing config in errors/logs.
- [ ] Defer full OAuth 2.1 dynamic registration/refresh until a real server
      needs it — static bearer covers hosted MCP servers for now; note the
      upgrade path (refresh-token grant at the transport layer).
- [ ] Tests: header is attached on connect; token absent from logs/events;
      unauthenticated (401) connect surfaces a clear startup error naming the
      server, not a mid-turn tool failure.

### M2-6 · Mutation audit log — `~1d` · P1
- [ ] Append-only JSONL (per session, or single file with sessionId field):
      `{ ts, userSub, sessionId, tool, argsHash, verdict, evidence }`.
- [ ] Write at executor dispatch completion (`synthetic-mcp/dispatch-executor.ts`)
      and on any gate denial (denials are security signal).
- [ ] This is interim — M3's store gets an `audit` table; keep the write
      behind a small `AuditSink` interface so the swap is one class.

### M2-7 · CLI interactive SSO login — Google + GitHub PKCE — `~2d` · P1
The CLI currently only carries a static `AGENT_API_TOKEN` (`cli/index.ts` ~L157).
For real user identity it needs an interactive login that yields the OIDC token
M2-1 verifies — without ever handling the user's password or holding a client
secret. Use OAuth 2.0 Authorization Code + **PKCE** with a loopback redirect
(the `gcloud`/`gh` pattern): public client, no secret, browser does the SSO/MFA.
- [ ] **Prereq — register one OAuth app per provider (manual, one-time).**
      Google: Cloud Console → Credentials → OAuth client ID, type **Desktop app**
      (loopback `http://127.0.0.1:<any-port>` allowed without registering the
      port; its "client secret" is non-confidential — PKCE covers it). GitHub:
      Developer settings → OAuth App; secret IS confidential and callback matches
      host+**port** (no random port) — so GitHub uses the **device flow** as its
      primary path to avoid shipping a secret, not the loopback. Client IDs are
      public (config, e.g. `flags.json`/env); NO secret in the repo or binary.
      No callback URL hosting is needed — the redirect is `127.0.0.1` on the
      user's own machine.
- [ ] `agent-local login <provider>` command (`cli/`): start a transient
      `http://127.0.0.1:<ephemeral-port>` server, open the system browser to the
      provider authorize URL with `code_challenge` (S256) + `state`, capture the
      `code` on the loopback redirect, then shut the server down. Validate
      `state`; bind the listener to loopback only.
- [ ] Exchange code + `code_verifier` for tokens at the provider token endpoint;
      store `{access, refresh, expiry, idToken}` per provider in an OS-appropriate
      location (`%APPDATA%`/`~/.config/agent-local/`), file perms `0600`, never
      in the committed config. Refresh silently when expired.
- [ ] **Google**: OAuth 2.0 / OIDC endpoints (`google-auth-library`'s
      `OAuth2Client` does loopback+PKCE+refresh); the `idToken` feeds M2-1's
      issuer/audience verification directly.
- [ ] **GitHub**: GitHub's OAuth device/web flow now supports PKCE for the web
      flow; GitHub issues no OIDC `idToken`, so map the `access` token → identity
      via `GET /user` and synthesize the `IdentityContext.sub`/claims the pipeline
      expects (document that GitHub is an OAuth-not-OIDC provider — the claim
      mapping lives next to M2-1's, not duplicated).
- [ ] Headless/SSH fallback: Device Authorization Grant (`--use-device-code`)
      printing a URL + user code and polling the token endpoint — no loopback
      server, for boxes with no browser.
- [ ] One `SsoProvider` interface (authorize URL builder, token exchange, refresh,
      identity mapping) with `google`/`github` implementations behind it, so a
      third IdP is one class; the token cache is provider-agnostic.
- [ ] `agent-local logout` clears the cache; redact tokens from all logs/errors.
- [ ] Tests: PKCE verifier/challenge round-trips (S256); `state` mismatch is
      rejected; expired access token triggers refresh, not re-login; token absent
      from logs; a fake authorize/token server drives the loopback flow end-to-end.

**Done when:** `agent-local login google` opens a browser, completes with no
secret in the binary, and a subsequent dispatch runs under the SSO identity that
M2-1 verifies; `agent-local login github` yields a mapped `IdentityContext`; both
refresh silently and never write a token to a committed file.

### M2-8 · Argument-level scoping (bound args) — `~1.5d` · P1
Tool scoping today stops at *which server/tool* a role may call
(`scoped-tool-client.ts`, per-model `mcp` list). The grant is "can use the
excel server" = every workbook — too coarse to be a real safety claim. Bound
args push the boundary one level deeper, into the *arguments*, so a grant
becomes "excel write, to **these** sheets" — the primitive a capability-block
palette (validator / excel-modifier / api-caller dropped into a workflow,
each scoped to its resource) is built from. Lands in the ToolPort SCOPE layer
(MR-1), *not* a new chokepoint: a thin decorator around each `Mcp` client,
same `ToolInvoker` interface, enforced server-side before disk/network — never
in the prompt (same by-construction rule as the `fsreadonly` mounts).
- [ ] Data model: a flat `{ "<server>__<tool>": { "<arg>": <bound> } }` map.
      Two flavors — **pinned** (runtime stamps a fixed value; arg dropped from
      the model-facing schema so small models can't supply it) and
      **constrained** (model supplies, validated against an exact-match
      allowlist; reject → corrective error naming the allowed set, reusing the
      existing `ScopedToolClient` corrective-error pattern).
- [ ] **v1 = pinned-only** (no matching logic at all): inject fixed values,
      strip the param from the advertised descriptor. Delivers
      "excel-modifier locked to one workbook" with zero matcher code and is net
      schema-*simplifying*. Ship this first.
- [ ] Constrained/allowlist flavor second, exact-string match ONLY. Add glob
      for path args (`reports/**`) only when a real workflow spans resources;
      never regex/expressions (that rebuilds the config-hell the few-roles
      posture avoids — keep it opinionated).
- [ ] Arg normalization before the check: canonicalize path/URL args via the
      same sandbox-root resolution the fs servers already use, so
      `./Q3.xlsx` ≡ `Q3.xlsx` ≡ abs path — loose matching is a hole, strict
      mismatch is an annoyance. Reuse, don't reinvent.
- [ ] Decouple capability-grant from model: a bound-arg block is a
      (tool-subset + bound-args) descriptor, composable independently of which
      LLM runs it — prerequisite for the workflow-block product direction
      (sub-server tool selection rides the same descriptor).
- [ ] Tests: pinned arg overrides a hallucinated value and never reaches the
      tool unstamped; out-of-allowlist constrained value is rejected with the
      allowed set surfaced; in-allowlist passes; path normalization treats
      equivalent forms as one; pinned param absent from advertised schema.

**Done when:** a test proves an excel-modifier block pinned to `Q3.xlsx`
cannot write any other workbook even when the model names one, and the pinned
arg is absent from the tool schema the model sees.

### M2-9 · On-behalf-of (OBO) delegation — subject+actor token exchange — `~1d` · P1
The host→agent hop today carries only the SERVICE identity (a client-credentials
bearer, `act`-less), so the agent knows *which service* dispatched a job but never
*which user* it runs for. OBO closes that: one exchanged token carries BOTH
principals — `sub` = the session subject (the human who triggered the work, with
their own permissions), `act` = the service acting for them (`agent:trigger`). RFC
8693 token exchange, two-claim and **never merged**, so each gate reasons about the
right principal (transport = actor's scope; on-behalf actions = subject's). Builds
on M2-1 (JWT verify) and feeds M2-2 (the subject bound on the session is what
ownership-binding checks resume against).
- [x] **Mint side — `/connect/token` token-exchange grant.** `signIdentity`/
      `verifyIdentity` (`@agent-local/common/jwt`) carry an optional nested `act`
      claim (`ActorClaim`); `POST /connect/token` accepts
      `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` + `subject_token`,
      verifies the subject against the host's own ring, takes the Basic principal as
      the actor, and mints `{ sub, permissions: subject's, act: { sub, permissions } }`.
      Client-credentials path unchanged; OIDC discovery advertises the new grant.
- [ ] **Thread the subject to mint (in-request).** `POST /api/works` passes
      `req.userContext.accessToken` into `Orchestrator.trigger`; `createSession`
      (`src/host/src/comms/sender.ts`) exchanges it for the OBO bearer it presents —
      the subject is captured at the HTTP boundary where it is freshest, never seeded
      onto a workflow process variable (no live bearer in engine history).
- [x] **Consume side — agent reads both principals + the gate moves.** — done
      (M8-7c3 + the 2026-07-02 `user_context` rework, see HS-5 in
      [BACKLOG.DONE.md](BACKLOG.DONE.md)): the caller resolves from the verified
      bearer alone; the actor's permissions gate `agent:trigger` and the OBO
      subject rides as `userId` (always present), so routes know who the work
      runs for.
- [x] **Bind subject to the session (dovetails M2-2).** — landed *differently*
      2026-07-02: the verified subject is bound at create (`SessionRegistry`)
      AND re-verified from the bearer on every call; the session-as-capability
      inheritance (follow-on `/events` without re-presenting a token) was
      **removed**, not built — a session id is not a principal.

**Done when:** a work triggered by user U dispatches to the agent under a token whose
`sub`=U (with U's permissions) and `act`=the dispatch service; the agent authorizes
the call on the actor's `agent:trigger`, attributes the work to U, and refuses a
resume by anyone but U.

---

## M3 — User-keyed store (≈ 1.5–2 weeks) — *supersedes disk-store findings*

Design rule (agreed): **user id is part of the lookup key**, not a post-load
filter — no code path can hydrate another user's session and forget to check.

### M3-1 · Repository interfaces — `~1d` · P0
- [ ] `SessionRepository`: `load(userSub, sessionId)`, `save(session)`,
      `summaries(userSub, {limit, offset})`, `delete(userSub, sessionId)`.
- [ ] Same treatment for context snapshots and workspace records
      (`workspaceId` partition under `userSub`; content-addressed snapshot
      *blobs* may stay global — the session→hash *mapping* is per-user).
- [ ] Keep the current `SessionStore` as `FileSessionRepository`
      (dev/CLI mode), keyed with a `userSub` subdirectory so the interface
      is honest even on disk.

### M3-2 · SQLite implementation — `~2d` · P0
> **Scope (2026-06-19):** one `better-sqlite3` file per process. This story is
> the **agent DB** (`agent.sqlite`, owned by the agent process); the host jobs
> store is its own DB — M3-H, **done** (the `WorkStore`/`HOST_SCHEMA` sqlite,
> see [BACKLOG.DONE.md](BACKLOG.DONE.md)). Memo stays out: it is the M3-6/M3-7
> vectorstore track, not a relational table.
> **dbup foundation landed (2026-06-19):** the idempotent schema-ensure engine
> (`common/src/db.ts`, `@agent-local/common/db`: `openDatabase` + `ensureSchema`
> — table/index create-if-missing, recreate-on-drift, lookup hydration from
> template) and the agent schema spec (`agent/src/agent/db-schema.ts`:
> sessions/conversations/messages/metrics + `session_status` lookup) are in.
> Run via an **explicit `db init` command** (`npm run db:init`, per-package
> `db:init` / `db:init:dev`), invoked once by `start.sh` after the build — NOT
> on every process boot, so a serving process never races schema work.
> **Remaining:** swap the repositories onto the tables + port `summaries()` to SQL.
> **Build caveat:** `better-sqlite3` has no prebuilt for Node 25, so it compiles
> from source. If the system `python3` (Homebrew 3.14) has a broken `pyexpat`,
> the node-gyp build fails — install with `npm_config_python=/usr/bin/python3
> npm install`.
- [ ] `better-sqlite3`; tables: `sessions(user_sub, session_id, status,
      payload, created_at, updated_at, PRIMARY KEY(user_sub, session_id))`,
      `contexts`, `audit`. WAL mode.
- [ ] Also cover the other agent file stores in the same DB:
      `metrics(session_id, ...)` (current-state row per session, replacing the
      JSONL fold in `runtime/metrics/metrics-store.ts`) and
      `conversations(conversation_id, created_at, deleted_at)` +
      `messages(conversation_id, seq, payload)` (replacing
      `conversation/conversation-store.ts`; soft-delete via `deleted_at`,
      summarize/compact = delete-and-reinsert in one transaction).
- [ ] Swap in via `StoreMiddleware` (config: `AGENT_STORE=file|sqlite`).
- [ ] Port `summaries()` to a SQL query (kills the load-every-file scan).
- [ ] ~~Migration script~~ — **dropped (2026-06-19):** existing on-disk data is
      throwaway local state; no backfill. New schema starts empty.

### M3-3 · Session leases — `~1d` · P0 (prereq for service mode)
- [ ] `leases(user_sub, session_id, owner_id, heartbeat_at)`; acquire on
      runtime build, heartbeat on finalize, steal stale leases (> N sec).
- [ ] `dispatchAsync` refuses without a held lease — replaces the in-memory
      `status === "running"` guard across processes.
- [ ] Test: two runtimes on one session — second is refused; stale lease is
      stolen after timeout.

### M3-4 · Durable sub-sessions — `~1.5d` · P1
- [ ] Persist child snapshots (id, intent, status) into the parent session
      record on spawn/settle (`session/session-manager.ts`).
- [ ] On boot/resume: reconcile — children persisted `running` but with no
      live runtime are marked `error("orphaned by restart")` and surfaced
      once via the notification seam.
- [ ] Test: kill/rebuild mid-child → parent sees orphaned status, not silence.

### M3-5 · Retention — `~0.5d` · P2
- [ ] `AGENT_SESSION_TTL_DAYS`; cleanup pass on boot (and later a timer in
      service mode) deleting expired sessions + their audit rows; never
      delete sessions with active leases.

### M3-6 · codeindex → generic vector engine — `~2d` · P2
Code knowledge and agent memory are the SAME primitive: an embedded record
searched by similarity. They differ only in how the record is produced
(walk-and-chunk a repo vs. save one bit) and where it lives
(`data/commits/<sha>/` vs `data/memories/<id>/`). This story lifts the
already-generic bottom of `codeindex` into a reusable engine; M3-7 adds memory
on top. No new store — a generalization.

The bottom two layers are already content-agnostic and reusable as-is:
`DbConnectionFactory`/`DbConnection` (raw SQL + JSONL file backend, currently
duplicated verbatim across `codeindex` and `codemcp`) and `EmbedAdapter`
(`local | voyage | openai`). The code-coupling lives only in the middle: the
fixed `ChunkRow` fields (`area`/`kind`/`language`/`symbol`/lines/`imports`),
the git-commit unit, the file chunkers, and the code enums in `search_code`'s
schema.

- [ ] **Extract a shared `vectorstore` package.** Dedupe the identical
      `DbConnection` types; merge the two `EmbedAdapter` copies
      (`codeindex/embed` write-side + `codemcp/embed` read-side) into one with
      `embedBatch` + `embedQuery`. Generic record:
      `{ id, namespace, content, embedding, metadata: Record<string, unknown> }`;
      repository `upsert / searchByEmbedding / delete`. The fixed `ChunkRow`
      fields collapse into `metadata`; typed `SearchFilters` becomes a generic
      equality filter over `metadata`.
- [ ] **Make the snapshot/version key optional.** Today everything is keyed by
      `commitSha` (immutable per-SHA snapshots). Code keeps that; memory is a
      mutable set with NO commit — so the version key is optional in the generic
      layer. Never fake a commit for memory (the deepest coupling to cut).
- [ ] **codeindex = code producer on top.** Keep walker/chunkers/commit model,
      but write through the generic repo: code fields (area/kind/symbol) move
      into `metadata`; output stays `data/commits/<sha>/`, byte-compatible.
- [ ] Tests: codeindex publishes an identical code index through the shared
      repo (same chunks, same search results as before); the optional-version
      path leaves code's commit behavior unchanged.

**Done when:** codeindex produces its code index through the shared
`vectorstore` repository with no change to `data/commits/<sha>/` output, and the
duplicated `DbConnection`/`EmbedAdapter` code exists in exactly one place.

### M3-7 · codemcp serves code + memory — `~1.5d` · P2
With the engine extracted (M3-6), `codemcp` reads BOTH stores and gains a write
path so it can *generate* memory embeddings — it is read-only today (the
embed-batch/write side lives only in the codeindex CLI), which is why M3-6 is a
hard prerequisite. Codebase knowledge and recalled memory are both "what do I
know about X", so one server answers both.

Memory is partitioned by **collection id**: `data/memories/<id>/`. An `id` is an
arbitrary collection of related memories — it may map to a user, a session, a
topic, or a cluster linked to other memories. The id is opaque to the engine;
any association (user/session/links) lives in record `metadata`, not in the
path. This generalizes the multi-`repository` partitioning already in `codemcp`
(`RepositoryEntry`/`repoReaders`) — a collection id is just a namespace.

- [ ] **Write path into codemcp** via the shared package: a save-one-record
      ingest (no walk, no chunk) — caller supplies `{ id, content, metadata }`,
      the server embeds + appends under `data/memories/<id>/`.
- [ ] **Tools** alongside `search_code`: `remember(id, content, metadata)`
      (write) and `recall(query, id?)` (search; `id` omitted searches across
      collections or a default). `search_code`'s code enums stay code-only;
      recall filters on generic `metadata`.
- [ ] **Read both stores.** codemcp resolves `data/commits/<sha>/` for code and
      `data/memories/<id>/` for memory through the same reader; a call targets
      one or the other by namespace/collection.
- [ ] **Real embeddings for memory.** The `local` adapter is a hashed
      bag-of-words — no paraphrase recall. Memory uses `voyage`/`openai`
      (already supported, config only); pin ONE provider+dim per collection
      (the code already guards this via `getEmbeddingDimension`).
- [ ] Tests: a `remember`'d bit is recalled by a paraphrase, not just exact
      match; recall scoped to one `id` does not return another collection's
      bits; `search_code` still returns code chunks unchanged; mismatched embed
      dim within a collection is rejected.

**Done when:** `codemcp.remember(id, "X")` then `recall` on a paraphrase returns
X scoped to that collection id, `search_code` still returns code chunks, and the
server reads both `data/commits/` and `data/memories/` through one engine.

> **Agent wiring (later):** the agent's `save_memory` / `search_memory`
> synthetic tools call `codemcp.remember` / `recall` with a collection id
> derived from the principal/session — tracked under the M3 identity work, not
> built here.

> **SQLite memo backend — deferred (2026-06-19):** considered a 3rd DB
> (`memo.sqlite`) as a `SqliteVectorStore implements IVectorStore` (a third
> backend alongside `file`/`pg`, serving codeindex + memo via the shared
> engine). Deferred until the agent (M3-2) and host (M3-H) SQLite DBs are built
> and the `better-sqlite3` wrapper is proven. When revisited: without
> `sqlite-vec` it is a consolidation win only (same brute-force cosine as
> `FileVectorStore`, just durable/single-file); `sqlite-vec` adds real ANN at
> the cost of a native extension — but `pg` already covers production ANN, so
> SQLite would be the "local but real" middle tier.

#### Grooming caveat — split into 5 packages (supersedes the M3-6/M3-7 shape above)

M3-6 lumps compute (embedding) and persistence (store) into one `vectorstore`
package. They change on different cadences — providers/dims churn independently
of storage backends — so groom this into **two leaf packages + three consumers**.
`vectorstore` takes embeddings as INPUT and never embeds, so it has zero
dependency on `vectorizer`; both are true leaves and each consumer wires them
together itself.

```
   vectorizer            vectorstore         ← two independent leaves
   (embed logic)         (store/retrieve)       no dep on each other
      \    \              /    /
        +--- codeindex / codemcp / memomcp     ← each depends on BOTH
```

> **All 6 packages shipped** (1 vectorizer, 2 vectorstore, 3 codeindex, 4 codemcp,
> 5 memomcp, 6 mcp) — see [BACKLOG.DONE.md](BACKLOG.DONE.md).

- [x] **`src/codemcp` on the engine** (`~1d`) — reads via `vectorstore`, embeds
      queries via `vectorizer`. `search_code`/`find_symbol` surface + results
      unchanged; code enums become a code-only typed wrapper over the generic
      filter. — done 2026-06-15: `codeRetrieval.ts` wraps `IVectorStore`; two-tier
      tools (`locate_code`/`locate_symbol`/`locate_file`/`expand_chunk`) and
      `related_code` added; `search_code`/`find_symbol`/`get_file_context` unchanged;
      integration-tested via `src/codemcp/integrationtests.sh`.
- [x] **`src/memomcp`** (new, `~1.5d`) — `remember`/`recall` over `vectorstore`
      + `vectorizer`, partitioned by collection. tenant/category live in
      `metadata` (filtering), NOT in the path; associations are a separate
      sidecar via `getMemoryAssociations`, never a record field (see "Memory
      record shape" below). Must use voyage/openai (local bag-of-words can't do
      paraphrase recall). — done 2026-06-15, see [BACKLOG.DONE.md](BACKLOG.DONE.md)
      (standalone server, id/vectorId split settled, `integrationtest.md` recipe).
**Sequencing:** all 6 shipped — see [BACKLOG.DONE.md](BACKLOG.DONE.md).

**Sharp edges to settle in grooming:**

- **Dim/model guard crosses both leaves** — "embedding dim must equal the pg
  `vector(N)` column" (`publish.ts` `getEmbeddingDimension`). Neither leaf owns
  it; it belongs in each consumer's wiring, pinned per-namespace.
- **File-backend layout must stay parameterizable** — codeindex needs
  `commits/<sha>/chunks.jsonl` (byte-compat); memomcp wants
  `memories/<ns>/records.jsonl`. `vectorstore`'s file backend takes
  `{ partitionDir, recordsFile }` rather than hardcoding `commits`/`chunks.jsonl`.
- **`vectorstore` must NOT know "commit/snapshot"** — the `commits` table /
  `commit.json` stays a codeindex-only sidecar on top. This is what guarantees
  memory never fakes a commit (the deepest coupling in M3-6).
- **`LocalMcp` is tied to state + eventing → lift all of `src/common` out
  first** — pulling `LocalMcp` into `src/mcp` drags its coupling to session state
  and signalling along, and `McpClient` already reaches back to
  `src/agent/.../common/lifetime.js` for `CancellationToken`. The whole of
  `src/agent/src/common/` is generic, not agent-specific — `lifetime.ts`
  (`CancellationToken`), `eventing.ts` (pub/sub), `container.ts` (DI),
  `ilogger.ts`/`filelogger.ts`. Decide in grooming whether to promote it to a
  shared `src/common` (a 0th leaf, `~0.5d`) that every package — vectorizer,
  vectorstore, mcp, codeindex, codemcp, memomcp — depends on, instead of each
  reaching back into `src/agent`. Pairs with the in-flight eventing migration
  (onEvent callbacks → pub/sub bus), which already aims at a clean eventing
  surface in `src/common`. — done 2026-06-14: promoted to `@agent-local/common`
  (lifetime/eventing/container/ilogger/filelogger + `TokenUsage`); `@agent-local/mcp`
  and the agent depend on it, no longer reaching back into `src/agent`.

- **Memory record shape — flat records, associations are a sidecar** (settled
  2026-06-14, for memomcp). A memory is just a `vectorstore` `VectorRecord`; all
  memory semantics are `metadata` conventions owned by memomcp, the store stays
  generic. `metadata`: `kind` (`core` = small/high-salience, always loaded by id;
  `archival` = the bulk, retrieved top-k by similarity), `category`, `tags`,
  `tenant`, `createdAt`, `source`. Recall = load the collection's `core` records
  **plus** top-k `archival` by embedding. Storage = JSONL rows per collection
  (`memories/<id>/records.jsonl`), append on `remember`, upsert-by-id (no commit
  snapshot — version key stays optional). **No inline `parentId`/links field.**
  Associations are a SEPARATE sidecar — `memories/<id>/associations.jsonl`,
  analogous to codeindex's `commit.json` — read via `getMemoryAssociations(id)`
  returning edges that carry their OWN `kind` + importance ranking. Build the
  association layer only when traversal is actually needed; until then memory is
  flat records + generic `metadata` equality filters. Keeps the deepest M3-6
  coupling cut: the store never learns "relationship," same as it never learns
  "commit."

- **Memory id vs vectorId — two entities, explicit reference, never an assumed
  shared id** (settled 2026-06-15, memomcp). A memory and the `VectorRecord`
  holding its embedding are SEPARATE entities (1:1 today). Apply the naming rule:
  `id` is an entity's OWN identity; a pointer to another entity is `<entity>Id`.
  So a memory keeps its own `id`, and `vectorId` is a real reference to its vector
  record (`= VectorRecord.id`). Do NOT collapse them onto one `id` and rely on the
  reader knowing they're the same — that ambiguity (is `id` the owner's id or a
  reference?) is exactly what this avoids. Wiring: `VectorRecord.id` = the
  vectorId; the memory's own id rides in `metadata.memoryId` as the back-reference;
  `remember` reuses the existing vectorId on overwrite (stable vector identity
  across re-embeds), `recall` surfaces both `id` and `vectorId`. **Why it
  generalizes:** chunking a long memory becomes one memory `id` with many
  `vectorId`s — zero renaming, the relationship was explicit from day one.

### M3-8 · codemcp streaming — `~1d` · P2
Today `search_code` / `get_symbol` embed the query, rank the whole result set,
then return one buffered payload. Large `k` or big chunks block the caller until
the last hit is serialized. Stream hits as they rank so the agent can act on the
first result while the tail is still coming.

- [ ] **Incremental hit emission.** `searchByEmbedding` keeps its buffered
      signature (the store stays generic), but the codemcp tool layer wraps it to
      yield ranked hits progressively — an async iterator surfaced over the MCP
      tool result so partial results land before the full set is ready.
- [ ] **Bounded backpressure.** Stop materializing every candidate before
      sorting on huge namespaces; cap the in-flight window and emit top-k as the
      heap settles. Pg can `ORDER BY <=> LIMIT` server-side; the file backend
      folds-then-streams.
- [ ] **Cancellation.** Honour the turn's `CancellationToken` mid-stream — a
      cancelled search stops ranking/emitting immediately (one signal from the
      source, wrapped downward; see AGENTS.md). Depends on `src/codemcp` on the
      engine (above).
- [ ] Tests: a streamed search yields the same final ordering as the buffered
      path; cancelling after the first hit stops further emission.

**Done when:** `search_code` surfaces hits incrementally with the same final
ranking as the buffered path, respects a mid-stream cancel, and never
materializes an unbounded candidate set.

### M3-9 · memory streaming (memomcp) — `~1d` · P2
`recall` returns core records + top-k archival by similarity (see "Memory record
shape"). Stream them the same way M3-8 streams code hits: core records first
(always-loaded, cheapest), then archival as similarity ranking settles, so the
agent can start reasoning before the long tail arrives. Depends on `src/memomcp`
(above) and shares the streaming surface from M3-8.

- [ ] **Core-then-archival ordering.** Emit the collection's `core` records up
      front (loaded by id, no ranking wait), then stream `archival` hits as the
      top-k heap settles — one ordered stream, core salience first.
- [ ] **Reuse the codemcp streaming surface.** Same async-iterator-over-tool-
      result shape as M3-8 rather than a second bespoke mechanism; the two
      servers differ only in what they rank, not in how they stream.
- [ ] **Cancellation + backpressure** identical to M3-8 — bounded window, stop
      on the turn's cancel signal.
- [ ] Tests: a paraphrase recall streams core before archival; final set matches
      the buffered `recall`; cancel mid-stream halts emission.

**Done when:** `recall` streams core records before archival hits, matches the
buffered result set, and reuses M3-8's streaming/cancellation surface instead of
duplicating it.

### M3-10 · Store-level AI retrieval — projection, two-tier & related search (progressive disclosure) — umbrella · P2
Retrieval today returns full records in one shot: `search_code` returns `k` whole
chunks, `get_symbol`/`get_file_context` return ALL matching chunk **bodies**, and
memomcp `recall` pulls every `core` record in full — and every read also drags the
**embedding** across the wire only to throw it away (codemcp `toChunkRow`, memomcp
`toRecalled` at [memoryRepository.ts](src/memomcp/src/memory/memoryRepository.ts)).
For AI analysis that's token-heavy and forces the agent to read bodies it may never
use — you cannot scan a collection to decide *what* to look at without first dragging
everything across. Deferred from the engine swap (M3-7 item 4), which kept
`IVectorStore` similarity-only.

**Guiding principle (settled 2026-06-15 review): keep the store dumb.** It does exactly
two things — cosine rank within a namespace (`searchByEmbedding`) + metadata equality
(`list`/filter). Every notion of "related" (siblings, neighbors, more-like-this) is
**composed in the consumer** (codemcp `CodeRetrieval` / memomcp `MemoryRepository`) from
those two primitives. No relatedness heuristics in the store; **no association sidecar**
until real multi-hop traversal is needed — the metadata codeindex already writes
(`path`/`symbol`/`parentSymbol`/`imports`) computes most "related" queries on the fly.

Status since groom: `list(namespace, filter?)` was promoted onto `IVectorStore` early
(commit 76596e5) but in **blunt form** — no `limit`, no projection, full records. memomcp
is the live proof of the waste. The "second consumer" gate is satisfied, so the
refinement is justified now. **Split into three sequenced phases, each its own story:**

- **M3-13 — Phase 1: embeddings write-only on reads** — ✅ **done 2026-06-15**, see
  [BACKLOG.DONE.md](BACKLOG.DONE.md). Vector stripped from read results; `get` keeps it.
- **M3-14 — Phase 2: content-free summary tier** (the two-tier locate→expand) — ✅ **done
  2026-06-15**, see [BACKLOG.DONE.md](BACKLOG.DONE.md). `VectorSummary` + `searchSummaries`/
  `listSummaries`; both codemcp and memomcp retrieve in two tiers.
- **M3-15 — Phase 3: related search** — the semantic more-like-this primitive (`relatedTo` +
  codemcp `related_code`) shipped ✅ **2026-06-15**; the remaining consumer-side relatedness
  (structural + hybrid + MMR + symbol boost) is split out as **M3-15b**, still open.

**Done when:** all three phase stories are closed — reads never carry an embedding, both
servers retrieve in two tiers (summary locate → by-id expand), and codemcp answers
"related to this" by composing vector neighbors + structural metadata, with no body
shipped until the caller asks to expand.

### M3-19 · pg edge parity — edges table + PgEdgeRepository — `~0.5d` · P2
The relationship graph shipped file-backend-only (2026-07-02): codeindex writes
`edges.jsonl` per snapshot and codemcp's `get_relationships` reads it; on pg,
`PgCommitRepositoryImpl.writeEdges` WARNs and drops, and codemcp wires
`NoEdgeRepository` (always empty). Parity needs: migration `003_add_edges.sql`
(commit_sha, from_id, to_id, type, line), pg writeEdges upsert (delete-then-insert
per sha), a `PgEdgeRepository` reader, and a tools test against pg.

### M3-11 · Indexer → codemcp index bundle (publish + handoff) — `~0.5d` · P2
The vector store and the metadata sidecar are written by the indexer but disagree on
layout, and codemcp serves them today by reaching into `../codeindex/data` directly
(the implicit sibling fallback in `repoFileDir`, [config.ts](src/codemcp/src/config.ts)).
That couples codemcp's served snapshot to the indexer's live working tree and leaves the
on-disk contract undocumented. Formalize the handoff: a **successful** index produces a
self-contained bundle, which is then **copied** into codemcp's data dir to serve.

- [ ] **One documented on-disk contract** both packages read/write: `data/commits/<sha>/`
      holding `chunks.jsonl` (vector records) + `commit.json` (snapshot metadata), plus a
      shared `schema_versions.json`. codemcp's `FileVectorStore` + `FileMetadataRepository`
      read exactly what `codeindex publish` writes — no flat-vs-nested ambiguity, no stale
      `chunks`-table / `StoredChunk` shapes.
- [ ] **Atomic publish.** `codeindex publish` (or a dedicated `bundle` step) emits the
      complete commits+metadata bundle on success only — a failed/partial index never
      overwrites or half-writes the serving set.
- [ ] **Explicit handoff.** A copy step (script or `codeindex` subcommand) places the
      bundle into codemcp's data dir, replacing the implicit reach into `../codeindex/data`,
      so codemcp serves a snapshot independent of the indexer's working tree.
- [ ] Tests: publish → bundle present and readable by codemcp's readers; copy → codemcp
      serves identical results from the copied dir; a partial index leaves the prior served
      bundle intact.

**Done when:** a successful `codeindex publish` yields a self-contained commits+metadata
bundle that copies cleanly into codemcp to serve, both packages share one documented
on-disk layout, and codemcp no longer depends on reaching into codeindex's working data dir.

---

### M3-12 · memomcp persistent/remote store — Voyage embeddings or local pg repository — `~1d` · P2
memomcp today runs `--backend file --embed-provider local` purely to verify connection
wiring (see [.mcp.json](.mcp.json)). The `local` embedder is hashed bag-of-words — no
paraphrase recall — and the file backend is a single-process JSONL, so neither is a real
memory store. Promote it to a persistent backend with real embeddings. Two candidate shapes
to evaluate (the `vectorstore` engine already exposes both file and pg backends from M3-6):

- [ ] **Option A — Voyage (or openai) embeddings.** Keep a durable store but swap the
      embedder to a hosted provider for genuine semantic recall. Wire `VOYAGE_API_KEY`
      through an `env` block in `.mcp.json` (never commit the key — same provider-key-scrub
      rule as M0-2), set `--embed-dim` to match the model, and confirm stored dims match on
      recall.
- [ ] **Option B — local Postgres repository.** Run memomcp on `--backend pg` against a
      local Postgres (`--pg-dsn` / `memomcp.config.json`), giving a real persistent, queryable
      store instead of single-process JSONL. Reuses the pg path already in `@agent-local/vectorstore`.
- [ ] **Decide the embed/persistence pairing.** The two options are not exclusive (pg backend
      + Voyage embedder is the strongest combo); pick the target and document the dim/provider
      contract so a later provider change doesn't silently mismatch stored vectors.
- [ ] Depends on the memory-namespace work in M3-7 / [[codemcp-vectorstore-layout]]: a memory
      namespace must get `retrieval` WITHOUT a commit.json sidecar (memory never fakes a commit).

**Done when:** memomcp serves remember/recall from a persistent store (pg and/or Voyage-embedded)
with real paraphrase recall, keys are injected via env and never committed, and the
embed-provider/dim contract is documented so stored vectors can't silently mismatch.

---

### M3-15b · Retrieval Phase 3 (cont.) — consumer-side relatedness (structural + hybrid + MMR) — `~1d` · P2
Continuation of **M3-15** (Phase 3 of **M3-10**). The semantic more-like-this primitive
shipped 2026-06-15 (`IVectorStore.relatedTo` + codemcp `related_code`, integration-tested);
see [BACKLOG.DONE.md](BACKLOG.DONE.md). What remains is the consumer-side relatedness that
composes the store primitives in `CodeRetrieval` — no new store method, no association sidecar.

- [x] **Semantic neighbors (more-like-this).** ✅ shipped — `relatedTo` is a single store
      primitive (pg keeps the seed vector server-side via a CTE; file ranks by the seed's
      stored embedding), excluding the anchor; codemcp `related_code` exposes it.
- [ ] **Structural relatedness — metadata only, no embedding:** same file (`list {path}`),
      class siblings (`list {parentSymbol}`), symbol def (`list {symbol}`), and dependency
      neighbors by resolving the stored `imports[]` → `path` (lightweight graph edge, no
      sidecar).
- [ ] **Hybrid expand (ship this).** On a `search_code` hit, return a deduped union of file
      context + class siblings + top vector neighbors as summaries (M3-14) — "I found this
      method, show me everything around it" in one call.
- [ ] **Diversity / MMR re-rank in codemcp.** Raw top-k cosine returns near-duplicate slices
      of one symbol; cap per `path`/`symbol` or MMR re-rank so related results span files.
      Quality heuristic lives in `CodeRetrieval`, not the store.
- [ ] **Boost exact-symbol matches.** A query string equal to a stored `symbol` outranks
      pure vector neighbors — merge `get_symbol` into `search_code` ranking, not a separate
      tool path.
- [ ] Tests: structural queries hit metadata only (no embed); MMR caps per-path duplicates;
      a symbol-exact hit ranks first.

**Done when:** codemcp answers "related to this" by composing vector neighbors + structural
metadata + import edges, deduped/diversified in the consumer, with the store still doing
only cosine + equality and no association sidecar.

> **Backend note (decide at M3-12 scale, not here):** pg `searchByEmbedding` does
> `ORDER BY embedding <=> q` with **no ANN index** ([pg-vector-store.ts](src/vectorstore/src/pg-vector-store.ts))
> → sequential scan. An HNSW index needs a **fixed column dim**, which conflicts with the
> current "dim unpinned, consumer guards" decision — pin-and-index vs. accept full scans is
> a real tradeoff to settle when a repo gets large.

---

### M3-16 · Cancellation signal through the vector engine (embed + store reads) — `~1d` · P2
The embed path is unabortable. `IVectorService.embedBatch`/`embedQuery`
([vector-service.ts](src/vectorizer/src/vector-service.ts)) take no signal, and the
Voyage/OpenAI `fetch` calls ([voyage.ts](src/vectorizer/src/voyage.ts) L38,
[openai.ts](src/vectorizer/src/openai.ts) L26) run with no `signal` — so the longest
operation in `codeindex publish` (the batch embed loop,
[publish.ts](src/codeindex/src/publisher/publish.ts) L62-79) and every codemcp/memomcp
query embed cannot honour a cutoff. Diverges from the AGENTS.md rule: one root signal
from the source, **wrapped downward**; tools observe, never originate. This is the
non-streaming plumbing the cancellation bullets in M3-8/M3-9 assume — a soft
prerequisite for them.

- [ ] **Leaves accept + forward an optional signal, never mint one.** Add
      `signal?: AbortSignal` to `IVectorService.embedBatch`/`embedQuery`, the
      `EmbedAdapter` calls, and forward to `fetch(url, { …, signal })` in voyage/openai
      (`local` is sync compute → no-op). Optional so today's CLI callers are unaffected;
      the leaf only forwards what the caller passes.
- [ ] **Optionally honour it on `vectorstore` pg reads.** `PgVectorStore.searchByEmbedding`/
      `list` ([pg-vector-store.ts](src/vectorstore/src/pg-vector-store.ts)) run bare; thread
      the same optional signal so a cancelled query stops the round-trip. File backend is
      sync read → check-and-bail only.
- [ ] **Consumers wrap the source downward.** `codeindex` CLI mints a root
      `AbortController` on SIGINT (it has none today — the M0-6 analog for the indexer) and
      passes `signal` into the publish embed loop, checking between batches so a long index
      stops promptly. Agent-side synthetic tools that already receive a `cutoffscope`
      (`CancellationToken` from `@agent-local/common`) forward `cutoffscope.signal`.
- [ ] **Cross-process MCP stays on the client-owned timeout.** codemcp/memomcp run as
      separate stdio servers; in-process they derive a per-request token and honour it, but
      cross-process cancel remains the per-model tool timeout the MCP client already owns
      (AGENTS.md) — do NOT invent a second cancel channel over stdio here.
- [ ] Tests: an aborted signal rejects an in-flight `embedBatch` (fake fetch that observes
      `signal`); `codeindex publish` stops between batches on abort, not mid-request; a
      no-signal call path is byte-identical to today.

**Done when:** every embed/store call accepts and forwards a caller-supplied signal,
`codeindex publish` aborts promptly on SIGINT, no leaf mints its own root signal, and the
no-signal path is unchanged.

---

### M3-17 · memomcp recall reranker — flag-gated re-rank of candidates — `~1d` · P2
Cosine top-k surfaces semantically near records but does not judge which actually answer the
query. Add a reranker stage to memomcp `recall`: after the vector store returns candidates,
score each against the query text and re-order by that score. Gated behind a flag (default off;
`rank: true` enables) so the cheap vector-only path stays the default. Composes the same
retrieval pipeline as M3-10 — no change to the store primitives (still cosine + equality).

- [x] **Flag to enable.** `rank` boolean threaded through `recall`
      ([recall.ts](src/memomcp/src/tools/recall.ts), [registry.ts](src/memomcp/src/tools/registry.ts)),
      default off so today's behaviour is byte-identical; `rank: true` turns the stage on.
- [x] **Rerank behind an interface, in the memomcp layer not the store.** `IReranker`
      ([rerank/reranker.ts](src/memomcp/src/rerank/reranker.ts)); `recall` over-fetches `k×4`,
      reranks, trims to `k` ([memoryRepository.ts](src/memomcp/src/memory/memoryRepository.ts)).
      The store stays agnostic (cosine + equality only).
- [x] **Reranker is a configurable role.** `reranker` role in [models.json](models.json) →
      `local-reranker` (`cross-encoder/ms-marco-MiniLM-L-6-v2`); the agent's provider registry
      skips non-chat providers so the declarative role can't crash startup
      ([providers-registry.ts](src/agent/src/agent/registries/providers-registry.ts)).
- [x] **Score returned + ordered by it.** Reranked archival is ordered by `rerankScore` (best
      first) and the score is stamped on each `RecalledMemory` and rendered (`rerank=…`),
      distinct from the cosine `score`.
- [x] Tests: flag off ⇒ cosine ordering untouched, no `rerankScore`; `rank: true` ⇒ a
      lexical-best candidate outranks a closer cosine hit and over-fetch trims to `k`; rank
      ignored when no reranker is wired ([memoryRepository.test.ts](src/memomcp/src/tests/memoryRepository.test.ts)).
- [ ] **DEFERRED — real cross-encoder + resolve the role from models.json.** Today
      `LocalReranker` is a lexical-overlap stand-in (offline, no model download) and memomcp
      does not read models.json. Wire memomcp to resolve the `reranker` role and run the actual
      `cross-encoder/ms-marco-MiniLM-L-6-v2` (or a hosted reranker) behind the same `IReranker`.
- [ ] **DEFERRED — cancellation + cost.** Once the reranker does real work, honour the caller
      signal (M3-16) and cap candidate count so the cost is bounded.

**Done when:** memomcp `recall` re-orders candidates by a reranker relevance score when
`rank: true`, the vector-only path is unchanged with the flag off, and the rerank stage adds no
new store method. _(Shipped behind `LocalReranker`; real cross-encoder + models.json resolution
are the deferred items above.)_

---

### M3-18 · Memory service — start-of-turn recall, `[memory]` injected into orchestrator only — `~1.5d` · P2
Today memory is only an on-demand tool: the orchestrator must choose to call memomcp `recall`.
Make recall automatic and symmetric to the EVALUATOR. The evaluator is the end-of-turn step
([runners/evaluator.ts](src/agent/src/agent/runners/evaluator.ts)); add a **start-of-turn
memory step** that recalls relevant memories from the latest user input and injects them as a
`[memory]` block into the orchestrator's context — invisible to the user, absent from the
executor (the executor runs one scoped ask and does not need standing memory). Depends on
M3-17 (recall uses `ranker=1`). memomcp **stays a general-use MCP** — this adds an automatic
caller, it does not replace the tool.

- [ ] **Start-of-turn memory step.** Run a recall step before the orchestrator's first
      iteration — the mirror of the end-of-turn evaluator. **Not gated on MR-4a:** land it
      inline at the start of the turn first (wherever the turn begins, alongside how the
      evaluator hangs off the end), then move it onto the MR-4a onion as a turn middleware
      ([runtime/turn/turn-middleware.ts](src/agent/src/agent/runtime/turn/turn-middleware.ts),
      wired at [runtime/agent-runtime.ts](src/agent/src/agent/runtime/agent-runtime.ts) ~L169)
      once that seam exists. Empty/failed recall ≡ today's behaviour (no `[memory]` block).
- [ ] **Recall query = recent input, not the whole transcript.** Build the query from the
      latest user input plus a short tail of prior turns (cap N, default ~2) so the recall
      stays scoped to current intent (same "scope to last intent" rule as M5-5), and call
      memomcp `recall` with `ranker=1`.
- [ ] **Inject as a `[memory]` block, orchestrator-only.** Feed the recalled memories into the
      orchestrator context as a labelled `[memory]` section
      ([context/context-loader.ts](src/agent/src/agent/context/context-loader.ts) /
      [context/system-prompt.ts](src/agent/src/agent/context/system-prompt.ts)). Never surface
      it to the user, never add it to the EXECUTOR context.
- [ ] **memomcp stays an MCP tool too.** The synthetic/start-of-turn caller and the
      general-use `recall`/`remember` tools share one server; do not fork a second path.
- [ ] Tests: a turn whose input matches a stored memory injects a `[memory]` block into the
      orchestrator context and nothing into the executor context; an empty recall leaves the
      orchestrator context byte-identical to today; the `[memory]` block never appears in
      user-facing output; the recall query is bounded to the last N turns.

**Done when:** every turn auto-recalls from the latest user input (last-N-turns query,
`ranker=1`) and injects a `[memory]` block into the orchestrator context only — hidden from
the user and the executor — while memomcp remains a general-use MCP.

---

## M4 — Service mode + observability (≈ 2.5–3 weeks)

### M4-0 · Telemetry foundation (`@agent-local/common/telemetry`) — `~0.5d` · P1
Standalone OpenTelemetry seam in `src/common/telemetry`, scaffold-only: the
`ILogger`/`IMetrics` surfaces and OTel-backed implementations land now, exporters
and env wiring come later (this is the substrate M4-3/M4-4 build on). Everything is
agnostic — config is **constructor-injected**, never read from `process.env` inside
the classes — and each constructed instance is **added to a `TelemetryRegistry`** so
consumers resolve `logger()`/`metrics()` by intent without knowing the source.
OTel's `@opentelemetry/api` + `@opentelemetry/api-logs` default to **no-op** providers
until an SDK is registered, so "empty for now" needs no exporter code — just the API.
- [ ] `telemetry/imetrics.ts` — `IMetrics` interface (counter add / histogram
      record by name + attributes), OTel-shaped.
- [ ] `telemetry/otel-metrics.ts` — `OtelMetrics implements IMetrics` over
      `metrics.getMeter(...)`; **empty / no-op** today (no env, NO fallback — an
      unexported metric has nothing sane to fall back to).
- [ ] `telemetry/otel-logger.ts` — `OtelLogger implements ILogger` emitting an OTel
      log record via `logs.getLogger(...)` (no-op until an SDK lands), **with no env**,
      and **falling back to `FileLogger`** for real output now (logs are still
      file-only — there is no SQLite log sink; `agent.sqlite`/`host.sqlite` cover
      sessions/conversations/messages/metrics/jobs, not logs). Liskov-substitutable
      for `FileLogger` so existing `ILogger` call sites are untouched.
- [ ] `telemetry/telemetry-registry.ts` — stateless holder/lookup (mirrors the
      registries pattern); `add({ logger, metrics })` once at bootstrap; exposes
      `logger()` / `metrics()`. Dumb lookup by intent; consumers compose.
- [ ] `package.json` — add `@opentelemetry/api` + `@opentelemetry/api-logs`; barrel
      + `./telemetry` subpath export.
- [ ] Tests: `OtelLogger` satisfies `ILogger` and forwards every level to the
      `FileLogger` fallback; `OtelMetrics` no-ops without throwing; the registry
      returns the added instances.

**Done when:** a process constructs `OtelLogger`/`OtelMetrics`, adds them to a
`TelemetryRegistry`, and code resolves an `ILogger`/`IMetrics` through the registry —
logs reach the file fallback, metrics no-op silently, and no class reads
`process.env`. Exporter/OTLP/env wiring is explicitly out of scope (later story).

> **Reframes M4-3/M4-4 (2026-06-27):** M4-3's Pino implementation is superseded —
> the registered `ILogger` becomes `OtelLogger` (file fallback) here, not Pino.
> M4-4's per-turn spans + metrics ride on this foundation's meter/logger once the
> exporter/env wiring lands.

### M4-1 · HTTP/SSE transport — `~3d` · P0
- [ ] Fastify (or hono) app exposing: `POST /sessions`,
      `POST /sessions/:id/dispatch` (SSE stream of runner events → final
      message), `POST /sessions/:id/inject`, `GET /sessions` (summaries),
      `GET /sessions/:id`, `POST /sessions/:id/compact`.
- [ ] Per-request bearer token → `IdentityContext` → existing pipeline
      (this is why M2-1 had to land first). 401 on auth `failed`.
- [ ] `runner-events` already define the streaming payload; serialize them
      as SSE events 1:1.
- [ ] One `AgentRuntime` per (user, session) held in an LRU; lease (M3-3)
      guards cross-process.

### M4-2 · Packaging — `~1d` · P1
- [ ] Dockerfile (multi-stage, node:20-slim), compose file with a volume for
      the SQLite db; `GET /healthz` (db reachable + MCP servers connected).
- [ ] Decide MCP servers in-container vs sidecar; document.
> **Cross-platform run scripts landed 2026-06-19** (commit "with temporal live
> container"): `scripts/start.sh`/`stop.sh` no longer assume Unix tools that
> Git-for-Windows bash lacks — port probes use the bash `/dev/tcp` built-in instead
> of `nc`; `pkill`/`lsof` are guarded with `command -v`; and `stop_port` falls back to
> PowerShell (`Get-NetTCPConnection` → `Stop-Process`) to reap the detached node child
> that binds a port on Windows. COMMANDS.md documents the docker runtime per OS
> (Rancher Desktop on Windows / colima on macOS — Lima does not run on Windows).

### M4-3 · Structured logging — `~1d` · P1
- [ ] Pino implementation of the existing `Logger` interface
      (`common/logger.ts`); inject via `LoggerMiddleware`.
- [ ] Event→log sink: subscribe a logger to runner events with
      `sessionId`/`turn`/`subSessionId` bound — one line per tool call,
      dispatch, verdict, warning.

### M4-4 · OpenTelemetry — `~2d` · P2
- [ ] Trace per turn; spans: provider.chat (per role), tool call, executor
      dispatch, evaluation. GenAI semconv attrs (model, tokens).
- [ ] Metrics: turn latency, iterations/turn, verdict distribution,
      tokens & est. cost by provider/role, gate denials, fail-open count.

### M4-5 · Behavioral eval harness — `~2d` · P2
- [ ] `evals/tasks.json`: N small tasks (create file with content X, edit Y,
      multi-step Z) + a deterministic checker per task (file exists/contains).
- [ ] Runner script using headless mode + exit codes; emits pass rate table.
- [ ] Nightly CI job against Ollama (or recorded fixtures) — catches prompt/
      model regressions before users do.

### M4-6 · Headless session-threaded e2e smoke test — `~0.5d` · P2
A live end-to-end smoke of the real headless CLI (`--run` / `--session`),
distinct from M4-5: that one is a task-table + deterministic file checker; this
is a *session-continuity* test — one logical conversation carried across four
separate process invocations (create → read → remove → delayed background poll),
asserting the session id threads, the file-state transitions are reflected in
the agent's own responses, and each run exits with the right code. The real
providers run (orchestrator=gemini, executor/evaluator=anthropic per
`models.json`), so it doubles as a provider-wiring + sandbox smoke.
- [x] **Session threading is `--session`-only.** `cli/args.ts` parses only
      `--run` and `--session`; the trailing positional `{prev-session-id}` form
      in [COMMANDS.md](COMMANDS.md) commands 3–4 is silently ignored and starts a
      FRESH session. The harness must thread `--session <id>` on every follow-up;
      the session id is captured from the `[session <id>]` line the CLI writes to
      **stderr** ([cli/index.ts](src/agent/src/cli/index.ts) ~L210), not from disk.
- [x] **Assert on the response, not the exit code alone.** The workspace is
      partitioned per session by `workspaceId` (UUID), so the harness checks the
      agent's stdout final answer — a deterministic content marker
      (`HELLO_E2E_MARKER`) the read must surface — never a fixed sandbox path.
      Asserting on the response (not exit code) is load-bearing: it caught a
      no-op the exit code rated as success (see M5-7), which a bare exit check
      would have called green.
- [x] **Committed harness:** [scripts/e2e-headless.ps1](scripts/e2e-headless.ps1)
      (Windows-primary) runs the four steps in order via `Start-Process node`,
      threads `--session`, and prints a per-step PASS/FAIL table; fails on any
      step that does not exit `0` or whose marker assertion misses. A `.sh`
      sibling is deferred until a non-Windows runner needs it.
- [x] **Delayed background step.** The 4th run (`delay … poll until done`)
      exercises the background-task + poll path under a threaded session; asserts
      exit `0` after the poll resolves.
- [ ] **Strict mode surfaces orchestrator flakiness (by design).** The configured
      orchestrator (`gemini-2.5-flash-lite`) intermittently no-ops to a
      clarification on actionable one-liners; the harness goes red on those runs
      rather than retrying (decided 2026-06-16). The fix lives upstream in M5-5
      / M5-7, not in the test — keep the test honest.

**Done when:** [scripts/e2e-headless.ps1](scripts/e2e-headless.ps1) carries one
session across all four runs via `--session`, asserts each step exits `0` AND the
read surfaces the content marker, and reports a per-step table — going red
(non-zero) whenever the orchestrator no-ops instead of acting.
_(Harness shipped + run 2026-06-16; the run surfaced the M5-7 headless-success
bug, layer 1 of which is now fixed.)_

---

## MR — Unified runtime refactor (≈ 9 focused days)

Full design and rationale in
[UNIFIED_RUNTIME_PLAN.md](UNIFIED_RUNTIME_PLAN.md). One-line versions here
for tracking; the plan doc has per-step file lists and acceptance criteria.
Absorbs M0-1 (gate) and M1-2 (token accounting); M2-4 (policy) plugs into
`resolveAllowedTools` afterward.

- [ ] **MR-1** · `resolveAllowedTools` + ToolPort skeleton (SCOPE →
      TRANSPORT); `resolveAllowedTools(modelRole, userPolicy, registry)` =
      model whitelist ∩ user policy at **server** granularity (tool
      granularity is the read/write server split, not a per-tool deny list);
      currently `userPolicy = anonymous` so model whitelist is the effective
      set — user policy plugs in at M2-3; M0-1 acceptance test = a user
      policy that restricts a server overrides the model whitelist at mount
      time — `~1.5d`
- [ ] **MR-2** · Runtime owns the port; orchestrator/executor stop building
      their own `ScopedToolClient` + filters; kill the dual descriptor
      assembly in `OrchestratorMiddleware` — `~1d`
- [ ] **MR-3** · `SyntheticToolSet` for dispatch_executor/subsessions/excel;
      delete `refreshTurnServers` + role methods from `McpClientRegistry`
      (registry becomes a neutral transport) — `~2d`
- [x] **MR-4·0** · Context consolidation — `RunnerContext` is the bundle — `~0.5d` · P1
      — ✅ **done 2026-06-16**, see [BACKLOG.DONE.md](BACKLOG.DONE.md). `RunOptions`
      folded onto `RunnerContext` (+ `runtime`/`coordinator`/`pullInjectedPrompts`);
      `AgentRuntime.beginTurn` mints the one per-turn object; `Orchestrator.setRuntime`
      + the `private runtime!` field retired; `includeSubSessions`/`?? "orchestrator"`
      micro-cleanups landed. **State-derived artifact pre-resolution (provider, surface,
      context snapshot, tracker) deferred to MR-4** — this story only changed *where the
      handle comes from* (ctx, not `this`).

- [ ] **MR-4** · Turn/round middleware — solid core loop, injectable
      behavior — `~3d`
  - **Goal:** `Orchestrator.run` shrinks to a stable stepper that owns
    nothing but the shape of execution: `resolve → for each round { model
    call → tool dispatch } → settle`. Every behavior that today is welded
    inline (`runners/orchestrator.ts`) — summarization, evaluator gate,
    nudge injection, `DispatchTracker`, usage folding, abort checks —
    becomes a middleware unit composed *around* the loop, never edited
    into it. Adding a behavior must touch no core-loop file.
  - **Two pipelines, same `(ctx, next)` contract as runtime `IMiddleware`**
    so the pattern is uniform across the codebase, just execution-scoped
    instead of build-scoped:
    - `TurnMiddleware` wraps one whole `run()` (one user prompt → final
      answer). Migrate here: `maybeSummarize`, subsessions rebind, `START`
      event, end-of-turn usage fold-back (**closes M1-2**), finalize.
    - `RoundMiddleware` wraps one loop iteration (one model call + its tool
      execs — the unit the code already calls a "round"). Migrate here:
      injected-prompt drain, `CompletionGate`/evaluator verdict + nudge,
      periodic `DispatchTracker` check, per-call usage fold, budget
      (M1-3) and stagnation (M1-9) as drop-in units.
  - `AgentRuntime.beginTurn()` → `TurnContext` (and a per-round
    `RoundContext`) carry the shared mutable state — working messages,
    usage, tracker, signal, verdict — that middleware reads/writes,
    replacing today's closure-captured locals. Registered via the
    `Container`/tokens DI seam (`getAll(MiddlewareToken)`), order-sensitive,
    each unit declaring fail-open vs fail-closed.
  - Decompose the leftover core helpers (assistant-turn normalization →
    tool-adapter; the `role === "executor"` branches collapse onto the
    gate per M5-1).
  - **Done when:** `run()` is a thin core (<~80 lines) with zero
    role/eval/summarize/budget branches; evaluator, summarizer, dispatch
    cap, and usage accounting each live in their own middleware unit-tested
    in isolation; and a new behavior ships as a registered middleware with
    no diff to the core loop.

#### MR-4a · Turn middleware onion — the mechanism — `~1d` · P1
> **Mechanism shipped** as `runners/middleware/runner-middleware.ts`
> (`RunnerContext`, `composeRunnerPipeline`, `RunnerPipelineMiddleware`,
> `RunnerMiddlewareToken`, folded at `agent-runtime.ts` ~L190). Name kept;
> MR-4·0 extends `RunnerContext` into the full per-turn bundle. **Still open
> here:** the `TurnCounterMiddleware` proof-of-seam consumer.

A runnable down-payment on MR-4: the onion pipeline that wraps one
`Orchestrator.run` (one turn), without yet decomposing the loop. Same
`(ctx, next)` contract as the init `IMiddleware` so the pattern is uniform —
build-scoped vs execution-scoped. Adding turn-scoped behavior never edits the
core loop.
- [ ] `runtime/turn/turn-middleware.ts`: `ITurnMiddleware { invoke(ctx, next):
      Promise<RunResult> }`, `TurnContext = { session, events: Eventing,
      signal, logger, registry }`, `TurnMiddlewareToken` (group),
      `composeTurnPipeline(mws, core)`.
- [ ] Wire at `runtime/agent-runtime.ts` (~L169): `this.orchestrator.run(opts)`
      becomes the pipeline core; `registry.getAll(TurnMiddlewareToken)` folds
      around it. **Empty group ≡ today's behavior** — the safety net.
- [ ] `TurnCounterMiddleware` lands here as the proof-of-seam consumer. The
      tally is **`invoke`-local** (the middleware instance is a singleton reused
      across turns — a field would bleed turns together); it subscribes on
      `ctx.events` and unsubscribes in `finally`. Two disjoint fields, two events:
      `direct` ← `MESSAGE.usage` (own model calls, per round); `delegated` ←
      `TOOL_RESULT.usage` (child-subtree cost, per tool end). Logs/stamps on turn
      end. It does **not** own a registry yet (MR-4b). Out of scope:
      MetricsRegistry, removing the inline `session.counters` folds, persistence.
- [ ] Delegated capture (the one non-orchestrator-core edit): add `usage:
      result.usage` to the `TOOL_RESULT` payload in
      [scoped-tool-client.ts:70](src/agent/src/agent/scoped-tool-client.ts#L70)
      so `delegated` has a source. Self-describing event — the producer states the
      cost, subscribers choose to record. `MESSAGE` already carries `usage`; this
      restores symmetry. Confirm `ToolExecutionResult.usage` is typed/populated
      first. **No diff to `orchestrator.ts` core loop** (different file).

**Done when:** a no-op middleware registered in the group runs around a turn with
the result unchanged; `TurnCounterMiddleware`'s `direct + delegated` tally equals
the sum the orchestrator folds into `session.counters` (`foldCounters` +
`foldDelegatedUsage`) that turn; zero diff to `orchestrator.ts` core loop.

#### MR-4b · MetricsRegistry — standalone fire-and-forget metric sink — `~1d` · P1
A container-owned observability sink modelled on **logging**: a producer *emits* a
metric and walks away — the registry never blocks the loop, never throws back into
it, and a dropped metric is a non-event (like a dropped log line). **Explicitly
NOT an accounting authority** — `session.counters` and the inline
`foldCounters`/`foldDelegatedUsage` stay exactly as they are; this is *parallel*
observability, decoupled from any counter migration. Depends on MR-4a (which
produces the first metric worth emitting).
- [ ] `runtime/metrics/metrics-registry.ts`: `MetricsRegistry.record(m: Metric)`
      with a standard envelope `Metric = { type: string; sessionId: string; ts:
      number; data: Record<string, unknown> }`. `record` is **sync, non-throwing,
      never awaited** — buffers the metric as a JSONL line in memory.
- [ ] Writer mirrors `Conversation`'s rolling-file pattern (watermark +
      append-only tail, never rewrite — see [conversation.ts:5-8](src/agent/src/agent/conversation/conversation.ts#L5-L8)):
      `flush()` appends only new lines to a per-run rolling `.jsonl` file.
- [ ] Flush cadence: on `finalize()` as the backstop (mirrors the conversation
      flush at [agent-runtime.ts:325-329](src/agent/src/agent/runtime/agent-runtime.ts#L325-L329));
      an interval/heartbeat flush is **optional** and deferred — no heartbeat infra
      exists today, so don't invent one for v1.
- [ ] Register via `MetricsRegistryMiddleware` (init pipeline) into the Container,
      resolved through `ctx.registry` like any other singleton.
- [ ] First + only producer this story — `logTokenUsage`: `TurnCounterMiddleware`
      (MR-4a) calls `record({ type: "token_usage", sessionId, ts, data: { direct,
      delegated } })` at turn end. Keyed by `sessionId` for now.
- [ ] Stays **additive**: MR-4a's local tally still equals `session.counters`; the
      registry is a *second* observer, not a replacement. Removing the inline folds
      / migrating `session.counters` is out of scope (separate future story if ever
      wanted).

**Done when:** a turn appends one `token_usage` JSON line (per session) to the
rolling file with `direct + delegated` matching the tally; `record` never throws
and never blocks the loop; deleting the registry registration leaves turn
behaviour byte-for-byte unchanged.

#### MR-4c · Any metric flows through the registry, fire-and-forget — `~0.5d` · P2
Generalize the MR-4b seam: the standard `Metric` envelope + `record()` becomes the
*one* way anything emits a metric, so a new metric type ships with zero registry
edits. Depends on MR-4b.
- [ ] Treat `Metric.type` as an open namespace (`token_usage`, future
      `tool_latency`, `round_count`, …); document the envelope as the producer
      contract — producers depend on it, never on the sink.
- [ ] Audit existing ad-hoc "metric-ish" logging and route what genuinely fits the
      envelope through `registry.record(...)` (audit only — don't force-fit real
      logs that aren't metrics).
- [ ] Pluggable sink behind the same `record()`: JSONL file is the default; a
      future sink (stdout / statsd / etc.) drops in with no producer change.

**Done when:** adding a new metric type is a single `record({ type: "…", … })`
call touching no registry code; producers compile against the envelope alone.

- [ ] **MR-5** · Factories: `RunnerFactory` (`runtime.runners`),
      `RegistryFactory.fromConfig`, `RuntimeFactory.standard()/child()`
      replacing `cli buildRuntime` + `build-sub-runtime.ts` — `~1.5d`
- [ ] **MR-6** · Import fence (lint rule: `runners/**` can't import
      registries/synthetic-mcp/mcp-client); update REGISTRY_PATTERN.md and
      README diagram; sweep dead exports — `~0.5d`

**Done when:** the five acceptance checks in UNIFIED_RUNTIME_PLAN.md §5 pass,
including `Orchestrator.run` under ~100 lines and one test proving
advertised surface ≡ dispatch enforcement.

---

## M5 — Core loop semantics (≈ 3–4 days) — *control logic, not hardening*

From the 2026-06-13 loop review. These change what the loop *does*, not its
resilience. Build them as `RoundMiddleware` on MR-4's loop + `CompletionGate`
seam — they are far cleaner as injectable round units than bolted onto today's
flat `for` in `runners/orchestrator.ts`, so MR-4 is a hard prerequisite
(consider pulling it forward). The terminal signal below *is* a gate input; the
plan state *is* what the gate reads.

### M5-1 · Completion signal — mostly by design; narrow residue — `~0.5d` · P2
**Groomed 2026-06-14: down-scoped.** Completion-by-absence-of-tool-calls is
**by design**, not the bug the original note framed. Each role has a completion
mechanism suited to its job:
- **Executor** is a bounded one-shot (ACK → execute → validate → RESULT). Its
  tool-free message IS the `RESULT OK/FAIL` report (`runners/orchestrator.ts`
  L230) — completion is *structural* (one ask, done, reported), so there is
  nothing for a judge to adjudicate and no explicit `done` signal is needed.
  The executor runs tools, not logic — that's the orchestrator's job — so its
  terminal report being the exit is intended, not inferred.
- **Orchestrator** is open-ended, and its tool-free turn is already adjudicated
  by the evaluator (`runners/orchestrator.ts` L228-280): a "narrated but not
  done" turn returns CONTINUE and is nudged, NOT silently exited. The premise
  that this is indistinguishable from a dropped call is largely already covered.

No separate synthetic `done` tool is warranted for correctness: a structured
declaration only improves host-side *extraction* of the signal, never the
model's *judgment* of whether it is done — and the evaluator is the judgment
authority. Residue worth tracking (not building speculatively):
- [ ] Evaluator *trigger*: the judge runs on EVERY tool-free orchestrator turn
      ("zero tool calls" is the trigger). If judge-call cost bites, gate the
      evaluator on a claimed-done signal so it fires on intent, not silence —
      efficiency/precision only, not correctness.
- [ ] Intent declaration up front → folded into M5-2 (plan/progress state) and
      M5-6 (orchestrator 3-phase prompt), not a standalone mechanism here.

**Done when:** the by-design rationale is recorded (this note); any
evaluator-trigger change is driven by an actual judge-cost signal, not built
speculatively.

### M5-2 · First-class plan / progress state — `~2d` · P2
The loop has no structured "what's left." The evaluator re-derives progress from
the whole transcript on every completion check and periodically
(`runners/orchestrator.ts` ~L455) — a second model call, lossy and costly. The
verbatim request anchor (~L247) patches goal drift precisely *because* there is
no progress state.
- [ ] Maintain a small explicit plan/checklist the model reads and updates each
      iteration (synthetic tool, or a structured block in the working messages).
- [ ] Re-ground the anchor with goal AND current plan/progress, not just the
      verbatim request — drifts less than re-quoting alone.
- [ ] Evaluator scores AGAINST the plan instead of re-reading the transcript;
      paired with M5-1 it runs only when done is declared (plus the periodic
      check), cutting judge calls.
- [ ] Test: a multi-step task shows the plan advancing; the verdict references
      plan items, not free-form prose.

**Done when:** the role branches in `Orchestrator.run` are gone (collapsed onto
CompletionGate) and a tool-free, non-declaring turn no longer terminates the loop.

### M5-3 · CLI control commands as parsed instructions — `~1.5d` · P2
A small, documented vocabulary of control keywords typed in the REPL (e.g.
`stop`, `list sessions`, `compact`) that the host recognizes and turns into a
structured `[system]` instruction injected into the loop, rather than treating
them as ordinary user prompts. The loop interprets the instruction
deterministically — `stop` ends the current turn (the unhook path in
`agent-runtime.ts` `stop()` / [[orchestrator-executor-architecture]]'s settle),
others map to session/runtime actions. Builds on the existing inject seam
(`POST /sessions/:id/inject`) and the M0-6 interrupt wiring.
- [ ] Define the command set + grammar in ONE registry (lean parser: exact
      keyword/prefix match, not NL) so CLI, SSE, and future hosts share it;
      unrecognized input falls through as a normal prompt.
- [ ] Host layer (`cli/index.ts` REPL) recognizes a command and emits the
      `[system] <verb>` injection; the loop's instruction handler dispatches it
      to the matching runtime/session action (stop, list, compact, …).
- [ ] Seed the initial context prompt with the available commands so the model
      is aware of them and can reference/suggest them — keep this list generated
      from the same registry, never hand-maintained in the prompt text.
- [ ] `stop` reuses the turn-stop path (no new chokepoint); pending turns stay
      queued per the `stop()` contract.
- [ ] Tests: `stop` mid-turn ends the current turn and leaves the session
      resumable; `list sessions` returns summaries without entering the model;
      a non-command sentence is dispatched to the model unchanged.

**Done when:** typing `stop` (or `stop main loop`) in the REPL injects
`[system] stop`, the loop halts the in-flight turn deterministically, and the
command vocabulary in the initial context prompt is sourced from the registry.

### M5-4 · Core turn-tools for sub-session control instructions — `~1d` · P2
The model-facing sub-session tools exist (`list_subsessions`,
`finalize_subsession` = stop-by-id, in `synthetic-mcp/subsessions-tools/`), but
the M5-3 `[system]` instruction path only wires parent-session verbs (`stop`,
`list sessions`, `compact`). A `[system] list sessions` (or `stop <subSessionId>`)
injected from the host has no deterministic core handler — it falls through to
the model instead of acting on the `SubSessionCoordinator` directly.
- [ ] Map `[system]` sub-session verbs to coordinator calls in the core
      instruction handler (M5-3 registry): `list sub-sessions` →
      `coordinator.list(sessionId)`, `stop <id>` →
      `coordinator.finalize(sessionId, id)` — no model round-trip.
- [ ] Reuse the existing coordinator seam (no new chokepoint); the synthetic
      tools and the `[system]` handler share one code path so model-driven and
      host-driven control can't diverge.
- [ ] Surface results via the same notification seam the REPL already uses for
      out-of-band sub-session events.
- [ ] Tests: injected `[system] list sessions` returns sub-session summaries
      without entering the model; `[system] stop <id>` finalizes that child and
      leaves siblings running.

**Done when:** an injected `[system] list sessions` lists the active
sub-sessions deterministically and `[system] stop <id>` finalizes that child,
both without a model round-trip and sharing the synthetic tools' coordinator path.

### M5-5 · Evaluator scoped to last intent; ambiguous input ⇒ nothing to evaluate — `~0.5d` · P2
The evaluator judges against the *last* intent only, but on an ambiguous
opener it over-reaches into clarification. Observed: request "create it again
the same way" with no prior context returned
`EVALUATOR: AWAITING-INPUT — "it"/"the same way" are ambiguous…`. That is the
*orchestrator's* job (it owns the user conversation); the evaluator demanding
clarification means it is reasoning about missing conversation history it
should never see. When the intent it is handed is not concretely evaluable,
the correct conclusion is "nothing to evaluate" — not a clarification request.
- [ ] Evaluator prompt + contract: scope strictly to the last intent and the
      work done this turn; it has no standing conversation/backlog and must not
      infer one. AWAITING-INPUT stays reserved for when the PROPOSED ANSWER is
      itself a question (rule 1) — never minted by the evaluator from an
      ambiguous *request*.
- [ ] Add an explicit "nothing to evaluate" outcome (or fold into SATISFIED with
      a no-op reason) for a request too underspecified to score, so the turn
      ends back at the orchestrator/user rather than the evaluator blocking on
      its own ambiguity (`runners/evaluator.ts`, `context/system-prompt.ts`
      ~L240 rule 1).
- [ ] Test: "create it again the same way" with empty/again-only context does
      NOT yield evaluator-originated AWAITING-INPUT; it returns the
      nothing-to-evaluate outcome and the turn defers to the orchestrator.
- [ ] **Inverse of the above (from M5-7, 2026-06-16):** the evaluator must also
      stop rating a pure clarification *answer* as SATISFIED. Observed: the
      orchestrator's "I need more information to create…" no-op intermittently
      returns verdict `satisfied` → headless exit `0`, masking a no-op as success.
      A tool-free turn whose content IS a question is AWAITING-INPUT, never
      SATISFIED — this is the open layer-2 of M5-7's headless-success bug.

**Done when:** an ambiguous, context-free request no longer produces an
evaluator-minted AWAITING-INPUT clarification, the evaluator never rates a
clarification *question* as SATISFIED (M5-7 layer 2), and the evaluator's verdict
is derived only from the last intent + this turn's transcript.

### M5-6 · Orchestrator prompt: explicit 3-phase shape — `~0.5d` · P2
An orchestrator turn should read as three clean phases, but the prompt
(`context/system-prompt.ts` ORCHESTRATOR_SYSTEM_PROMPT, L21-134) only expresses
the middle one:
  1. **State intent / plan** — what it will do this turn. MISSING at the turn
     level: intent today lives only per-mutation inside `executor__dispatch`'s
     `intent` field, never as a turn-level plan.
  2. **Execute** — gather context, dispatch one tool, parse ACK/RESULT,
     recalculate. Well covered (the "Loop" section, L53-68); leave as-is.
  3. **Declare a typed result** — done / more-info-needed / cannot-complete.
     DELEGATED, not declared: the orchestrator only "write[s] a final
     user-facing summary with NO tool calls" (untyped prose, L66-68); the result
     vocabulary lives on the EVALUATOR as SATISFIED / AWAITING-INPUT / FAILED
     (L198-205), which classifies the prose after the fact.
- [ ] Add phase 1: a turn-level intent/plan statement (ties into M5-2's plan
      state — the plan IS the intent declaration; don't build two).
- [ ] Add phase 3: the orchestrator declares its own typed result, categories
      mirroring the evaluator verdicts (done≈SATISFIED, need-info≈AWAITING-INPUT,
      cannot-complete≈FAILED). The evaluator then RATIFIES a structured proposal
      instead of classifying free prose (proposal-vs-authority split, see M5-1).

**Done when:** the orchestrator prompt is organized as the three explicit
phases, phase-3 result types line up 1:1 with evaluator verdicts, and the
evaluator reads a declared result rather than inferring one from prose.

### M5-7 · Headless no-op clarification must not report success — `~0.5d` · P1
Surfaced by the M4-6 e2e (2026-06-16). A turn where the orchestrator did **no
work** and only asked the user a clarification question was indistinguishable
from real completion in headless mode — it exited `0`. Two distinct layers, one
fixed here, one open and owned by M5-5:
- [x] **Exit-code conflation (FIXED).** `RunResult.outcome` collapsed
      `awaiting-input` into `"satisfied"` ([orchestrator.ts](src/agent/src/agent/runners/orchestrator.ts)
      ~L240), and `cli/index.ts` mapped `satisfied → 0`, so a clarification that
      reached an `awaiting-input` *verdict* exited `0`. Fix: added a distinct
      `"awaiting-input"` outcome member, returned it from the tool-free
      orchestrator gate, mapped it to a new `EXIT_AWAITING_INPUT = 4` in
      `cli/index.ts`, and made `agent-runtime.ts` treat it as the healthy
      `awaiting-input` session status (not `error`). Verified: `--run "read me
      something content"` (no file) now exits `4`, was `0`.
- [ ] **Evaluator mislabels a clarification as SATISFIED (OPEN → M5-5).** The fix
      only covers the `awaiting-input` *verdict* path. The evaluator
      ([runners/evaluator.ts](src/agent/src/agent/runners/evaluator.ts)) is
      inconsistent: the SAME "I need more information to create…" no-op sometimes
      returns verdict `satisfied` → outcome `satisfied` → exit `0`, leaking the
      no-op as success. The AWAITING-INPUT-reserved-for-questions rule
      (`context/system-prompt.ts` rule 1) exists but the judge doesn't reliably
      apply it. Fold into M5-5: a clarification question is never SATISFIED.
- [ ] **Document the headless exit codes** (`0` satisfied / `1` error / `2`
      capped / `3` failed / `4` awaiting-input) in COMMANDS.md / README so
      callers can branch on them (closes the M0-7 "document exit codes" item for
      this dimension).

**Done when:** a headless run that ends on a clarification question exits
non-zero by BOTH paths — the `awaiting-input` verdict (done) and the evaluator
no longer rating a pure clarification as SATISFIED (via M5-5) — and the exit-code
contract is documented. _(Layer 1 shipped 2026-06-16; layer 2 tracked in M5-5.)_

### M5-8 · Evidence-based completion gate — judge reads real state, not claims — `~1.5d` · P1
Surfaced 2026-06-20 from two `userTableTestWorkflow` runs that reported
`completed` / "user table created" with an EMPTY workspace (no file ever
written). Root cause was twofold and the deterministic backstops shipped
alongside this note (see below); this item is the remaining *judgment* layer.
- **Shipped 2026-06-20 (deterministic guards, not this item):**
  - Executor "no tool = failure": an executor sub-run that ends tool-free
    having issued ZERO tool calls now returns `outcome: "failed"`
    (`runners/orchestrator.ts`), so a fabricated ACK/REPORT can no longer bank
    a no-op as `satisfied`. (This corrects the M5-1 "completion-by-absence-of-
    tool-calls is by design" framing for the executor: absence of *any* tool
    call is now a failure, not a result.)
  - Dispatch tool-name grounding: `executor__dispatch` rejects a `tool` not on
    the executor's live surface (`synthetic-mcp/executor-server.ts`), killing
    hallucinated names (e.g. `excelmcp__create_excel`) at the boundary.
  - Context fortification: orchestrator/executor prompts now forbid inventing
    tools and require declaring failure when no tool can do the work
    (`context/system-prompt.ts`).
- [ ] **Evaluator judges from evidence, not prose.** The evaluator
      ([runners/evaluator.ts](src/agent/src/agent/runners/evaluator.ts)) reads
      the verbal transcript + the orchestrator's claim. It returned "on track"
      while the asserted file did not exist. Give the gate (or the evaluator) a
      read-only check against actual workspace/state before SATISFIED — a
      claimed artifact that a read-back can't confirm is not SATISFIED.
- [ ] **Don't fail-open to SATISFIED on a terminal completion.**
      `evaluateCompletion` swallows judge errors as `satisfied`
      (`runners/orchestrator.ts` ~L496); for the final completion gate that
      leaks an unverified pass. Fail-open should not stamp terminal success.
- [ ] Test: a workflow whose executor never wrote the file ends `attention`
      (failure fold), never `complete`; a run with the file present still completes.

**Done when:** completion is evidence-gated — a turn claiming an artifact that
an independent read cannot confirm cannot reach SATISFIED, and judge-error
fail-open no longer yields terminal success.

### M5-9 · Structured turn responses — a parseable answer channel distinct from the turn verdict — `~1.5d` · P1
Surfaced 2026-06-21 from `userTableFailTestWorkflow` run `ce2ae2f6` (session
`161bdee9`): the verify step asked "confirm row userId=55/userName=foxmulder
exists; fail if missing". The agent verified HONESTLY (executor query returned
`matched_count: 0`, orchestrator reported "the row does not exist"), yet the
work landed `completed` / "user table verified". Root cause: the per-turn
evaluator answers *"did the agent do the turn?"* (yes) — not *"what was the
answer to the question?"* (false). The assertion result has nowhere to live:
`agentResult.result` is free-text prose, `outcome` is the turn verdict, and the
evaluator's `FAILED` means "task impossible", not "asserted condition is false".
So a legitimately-violated assertion can never trip the workflow's
`outcome !== "satisfied"` gate.
- **Shipped 2026-06-21 (precursor, not this item):** the per-turn evaluator is
  now config-gated (`orchestration.evaluatorEnabled`, default `true`; set
  `false` in `models.json`) — it was a guard rail for weaker models and is off
  by default for capable ones. This removes the rubber-stamp path but leaves the
  assertion-answer gap below; structured responses are the real replacement.
- [ ] **Parseable answer contract.** Define a structured verdict an assertion
      step returns alongside the turn outcome — e.g. a final-message token
      (`ASSERT: PASS|FAIL`) or a one-line JSON `{ "holds": boolean, "detail" }`.
      `agentResult.result` is already typed `unknown`, so it can carry the object
      end-to-end through `mount.ts` → the `agentResult` signal.
- [ ] **Workflow gates on the answer, FAIL closed.** Add an `assertStep(prompt)`
      sibling to `createStepRunner`'s `runStep`
      ([workflows/user-table-test.ts](src/temporal/src/workflows/user-table-test.ts))
      that parses the answer and throws `AgentStepFailed` on FAIL *or* on an
      unparseable answer — the opposite bias to the evaluator's deliberate
      fail-open, because a verify gate must not pass on doubt.
- [ ] **Hardening (optional follow-up).** If free-text token drift shows up,
      promote the answer to a synthetic `report_assertion(holds, detail)` tool so
      the structured value is the tool arg, not parsed prose.
- [ ] Test: `userTableFailTestWorkflow` ends `attention` (failure fold) via the
      assertion channel (not the evaluator), and the positive `userTableTestWorkflow`
      (row present) still completes.

**Done when:** an assertion-style step fails the work whenever its asked
condition is false — independent of the per-turn evaluator — and a missing/
malformed structured answer fails closed rather than banking a false pass.

---

## M6 — Feature-flag registry (≈ 1–1.5 days)

### M6-1 · Flag registry + retrieval — `~1d` · P2
A central place to define and resolve feature flags, mirroring the existing
config registries (`ModelRegistry`, planned `PolicyRegistry`) — so toggles like
the streaming mode flag (M1-11) live in one artifact, not scattered booleans and
`process.env` reads.
- [ ] `flags.json` (sibling of `models.json`):
      `{ <flag>: { default, byMode?, byRole? } }`; `FlagRegistry.load()` +
      `isEnabled(flag, ctx)` / `get(flag, ctx)` resolving against runtime mode
      and (later, via M2) the principal's policy.
- [ ] Expose via a `FlagsMiddleware` stamping `ctx.flags`; runners and providers
      read flags through it, never `process.env` ad hoc.
- [ ] First consumers: `streamOutput` (M1-11); fold in any new loop toggle (e.g.
      the M1-9 stagnation break) so it graduates from config constant to a flag.
- [ ] Test: a flag resolves to different values by mode; an unknown flag returns
      its declared default, not `undefined`.

---

## M7 — Workflow orchestration (workflow engine × Agentic mesh)

> **Camunda retired — 2026-07-02.** `src/camundahost` and `src/workflow` (the
> Zeebe client) were deleted from the repo; **Temporal (M7-9/M7-10) is the only
> engine**. The camunda-only stories (M7-1, M7-5, M7-7) moved to
> [BACKLOG.DONE.md](BACKLOG.DONE.md) as retired. The remaining items are
> engine-neutral (bus seam, work-unit registry, host IAM); where "Camunda"
> still appears in their prose it reads as history of how the seam was proven.

A long-running business-process layer that *drives* the agent. Originally
Camunda 8 (Zeebe) owned the BPMN process state — now Temporal owns the workflow
state; either way the agent is a worker the engine dispatches to. The Node
side — workflow service + agentic engine — is **co-hosted in one express process
to start** for operational simplicity; the two are kept architecturally
independent by the bus and are split out later when load demands it (decided
2026-06-17, see **D6**). The Zeebe broker is always a separate Java process
regardless of Node topology.

**The bus is the seam — engines talk only through it, never by direct call.**
That single rule is what makes co-hosting safe: nothing couples across the seam,
so "extract into its own process" later is a *transport swap* behind the same
`publish`/`subscribe`/`add` contract (in-memory `Eventing` today → a pub/sub
broker next), not a rewrite.

**Invariant — the engine always initiates.** The only flow is
`engine job → agent dispatch → result → the engine advances the process`.
The agent never starts a process; it answers jobs and reports back.
The bus is bidirectional (events bubble both ways) but *initiation* is one-way.

Depends on: M4-1 (HTTP/SSE transport — the agentic API surface), M4-2
(packaging), and the [[eventing-migration]] bus being the live event path.

> **Bootstrap landed 2026-06-17** (4 parallel agents + integration). The express
> backend is its own workspace **`@agent-local/host` (`src/host`)** — a deliberate
> split from "workflow bootstraps express": it owns the single `Eventing` bus root,
> a `MountContext = { bus, logger, signal }` mount contract, the shared event
> taxonomy (`src/host/src/events.ts`), `/healthz`, and guarded dynamic mounts so it
> boots standalone. `@agent-local/workflow` and `@agent-local/web` mount into it;
> verified live (host serves `/healthz` + SSR, both siblings mount, mesh wired).
> **Eventing was NOT extracted** — it stays in `@agent-local/common`; the mesh
> shipped as `@agent-local/common/mesh` (`wireCamundaMesh`). **Deferred next:** the
> agentic engine (M7-2) — it fills the `dispatchToAgent` stub + `completeJob` seam;
> and the real-broker end-to-end cycle.

### M7-2 · Packagable agentic engine — resilient background service — `~2.5d` · P0
Wrap the host-agnostic runtime + the M4-1 HTTP surface into one embeddable
engine object. ~~**Co-hosted today**~~ — **superseded 2026-06-19 (see M7-3
reversal):** the agent already runs as a SEPARATE express service
(`src/agent/src/server/`) reached over HTTP, not co-hosted in-process. It exposes
`/session/create`, job intake (`/events`), and `/healthz`; the `createAgenticEngine`
factory shape (start/stop/health + drain + leases) below is still the open work —
the standalone *process* exists, the resilient *engine object* contract does not
yet. Bullets stay open against that contract.
- [ ] `createAgenticEngine(deps)` factory (`src/agent/src/agent/engine/`):
      composes `buildRuntime` + the M4-1 app into `{ start(), stop(), health() }`;
      `start()` connects MCP servers and subscribes its bus handlers, `stop()`
      gracefully drains in-flight dispatches then releases leases (M3-3).
- [ ] Mountable + daemon parity: expose the engine as express middleware/router
      the workflow process mounts in-process (today), AND export the factory from
      the package `exports` + a `bin` (`agent-engine`) for standalone hosting
      (later) — same composition root, no logic fork between the two.
- [ ] Resilience: crash-only supervision (uncaught/unhandled → log → flush →
      controlled exit for a process manager to restart), MCP reconnect, `/healthz`
      = db reachable + MCP connected + listener bound (reuse the M4-2 health
      contract; don't fork it).
- [ ] Job-shaped entry: a single-shot `POST /execute` (task in → final result +
      session id out) suited to a workflow call, layered over the existing
      `POST /sessions/:id/dispatch` — one request, one durable session, one
      result; no new loop.
- [ ] Tests: `start()`/`stop()` is idempotent and drains; `/healthz` flips to
      unhealthy when an MCP server is down; `/execute` returns a result for a
      trivial task in-process (no broker needed).

**Done when:** the engine starts as a standalone daemon (`agent-engine`) serving
`/healthz` + `/execute`, AND the same factory boots in-process from a test —
`stop()` drains active work and the process exits clean.

### M7-3 · Mesh link — Eventing in `common` + correlation routing — `~3d` · P1
Register one bus root in the host and route by correlation id so Camunda jobs
reach the agent and results flow back. **In-memory transport for v1** (co-hosted);
the seam is designed so a pub/sub broker is a later transport swap, not a rewrite.
- [x] ~~Extract `Eventing` to a standalone package~~ — **reversed 2026-06-17** (user
      decision): `Eventing` stays in `@agent-local/common` (existing import path
      `@agent-local/common/eventing` unchanged). The mesh shipped alongside it as
      `@agent-local/common/mesh`, not a new workspace.
- [ ] Define a `Transport` seam behind the **same** `publish`/`subscribe`/`add`
      contract. v1 ships the in-memory bus only; document the broker adapter
      (`publish` also forwards over the wire, inbound frames re-`deliver` locally)
      as the next step — build the interface now, the wire later. No engine code
      changes when the transport is swapped.
- [x] One `Eventing` root registered in the host bootstrap
      (`src/host/src/index.ts`, **not** `src/workflow`); the workflow worker
      `publish`es `workflow.job` (`processInstanceKey`, `jobKey`, `jobType`,
      `variables`) onto the bus instead of calling the agent — the agent subscribes,
      never the reverse. *(2026-06-17)*
- [x] Mesh router `wireCamundaMesh(bus, deps?)` (`common/src/mesh.ts`): correlates
      `jobKey`/`processInstanceKey` ↔ `sessionId` (per-instance session, retired on
      completed/failed) and routes `workflow.job` to a **`dispatchToAgent` stub
      seam**. `agent.result` reserved as the return path. Wired into the host. *(2026-06-17)*
- [x] Fill the seam — **landed 2026-06-17 (bus-only)**: the mesh's default
      `dispatchToAgent` now publishes `agent.job` (correlated) instead of an HTTP
      `/execute` call; `@agent-local/agent` exposes `mount` (`./mount`) — a
      **bus-only worker** (ignores the express app) that subscribes to `agent.job`,
      runs one runtime turn, and publishes `agent.result`. The workflow mount calls
      `completeJob(jobKey, vars)` on `agent.result`. Host composition is now three
      tidy seams in `src/host/src/index.ts`: `wireCamunda` / `wireApi` /
      `wireAgentWorker` (`src/host/src/wiring/`).
> **Reversed 2026-06-19 — agent is now a SEPARATE HTTP service, not a bus-only
> in-process worker.** The `common/src/mesh.ts` (`wireCamundaMesh`) + its test and
> the `src/host/src/wiring/*` seams were **deleted**; `@agent-local/agent`'s bus-only
> `mount` (`src/agent/src/worker/`) was replaced by a standalone express service
> (`src/agent/src/server/`: `index.ts`, `api.ts`, `contract.ts`, middleware,
> `session-registry.ts`, `sender.ts`, `appsettings`). The host now reaches it over
> HTTP: `HttpJobSender`/`AgentClient` (`src/host/src/agent-client.ts`) subscribes
> `WORKFLOW_JOB` and POSTs the job (envelope form) to the agent's `/events`;
> `Orchestrator` (`src/host/src/orchestrator.ts`) opens/closes one agent session per
> work unit via `/session/create`; results return via `POST /receive` →
> republished onto the bus (`src/host/src/api/receive.ts`). The bus seam contract is
> unchanged (this is the documented transport swap, in-memory → wire), but the agent
> is no longer co-hosted in-process. **Open:** the `Transport` seam abstraction
> bullet above is now embodied by `AgentClient`/`JobSender` (HTTP impl); gRPC/broker
> remains a later impl swap behind those interfaces.
- [ ] *Remaining for "done":* a live-model turn + running engine E2E — the
      Zeebe-broker variant **retired 2026-07-02** (Camunda deleted); the live
      E2E is the Temporal one tracked in M7-10.
- [ ] Enforce the invariant in code end-to-end (agent has no path to start a
      process) + an E2E test asserting on engine state (Temporal since
      2026-07-02), not logs.

**Done when:** starting the sample process instance drives one full
`engine job → agent execute → result → job complete → process advances` cycle
over the Eventing mesh, with the agent reachable only as a worker. *(bus + mesh +
publish/correlate landed 2026-06-17; closes once M7-2 fills the dispatch seam.)*

### M7-4 · Session lifecycle status — `active | finalized | error` — `~1d` · P1
The agent worker opens one runtime session per Camunda process instance and closes
it on instance end (M7-3). Today `Session.status` is `idle | running |
awaiting-input | error` — that's **per-turn** state, not lifecycle. Add an explicit
session lifecycle status so a session's place in the instance lifetime is queryable
and the console (M8-3) can distinguish live vs done sessions.
- [ ] Add `lifecycle: 'active' | 'finalized' | 'error'` to `Session` (distinct from
      the per-turn `status`); set `active` on open in `SessionMiddleware`.
- [ ] Worker (`src/agent/src/worker/mount.ts`): set `finalized` on
      `workflow.completed`, `error` on instance-level `workflow.failed`, **before**
      `shutdown(drain)` so the persisted session records its terminal lifecycle.
- [ ] Surface it on `SessionSummary` / the store so the console + session picker can
      filter active vs finalized.
- [ ] Tests: open → `active`; completed → `finalized` persisted; instance-failed →
      `error` persisted.

### M7-6 · Work-unit registry — host-owned job lifecycle + `workId` correlation — `~1.5d` · P1
The host is the orchestrator and owns the **work unit** — the join that ties a
user's request to its Camunda instance and its agent session. None of the three
engines should hold that join: Camunda knows `processInstanceKey`/`jobKey`, the
agent knows `sessionId`, and only the host knows they are the same piece of work.
`jobId` is the **`workId`** — the one id the host hands the agent and gets echoed
back; the agent treats it as opaque (round-trips it, never parses it), so the
agent boundary sheds every Camunda-shaped field. This makes the agent a generic
executor and the host the only place work status is queryable (the M8 console
reads it).

**The id model — the host owns the TRUE session; `workId` is its key:**
*(reshaped 2026-06-18)* — `workId` is not just a correlation join, it **is** the
work unit / true session, host-owned. It binds, **1:1:1**, the three facets none of
the engines should own together:
```
workId (= the unit of WORK — request start → end, reflects work done; host-owned)
  ├─ status:        new | running | attention | complete   (4 stored states — see M8-4; `attention`
  │                 folds user-stop/engine-cancel/failure, `complete` is the only terminal)
  ├─ workspaceId:   guid naming the shared folder/bucket (workspaces/<workspaceId>)
  ├─ sessionId:     the agent session (metrics + conversation), linked under the unit
  │                 (SUPERSEDED 2026-06-24 — no longer 1:1: each dispatched STEP gets its own
  │                 job session + one cli session, keyed (work_id, run_key, step_key); see DONE M7-13)
  ├─ camundaId:     processInstanceKey — the one linked Camunda execution
  └─ currentJobKey / step:  the live Camunda task to complete
```
`workId` and `workspaceId` are **deliberately distinct**: `workId` is the unit of
*work* (effort/status the host reports), `workspaceId` is just the *storage locator*
for the file area — different concerns, kept as separate ids even though 1:1.
**1 `workId` = 1 `workspaceId` = 1 agent session = 1 Camunda execution.** The unit is
**1:N** with Camunda `jobKey`s (a workflow emits several service tasks over its
life); every task resolves to the **same** session + workspace, so files and
conversation persist across the whole run. The host holds every link; the agent
sees only its own `sessionId`. The host tracks the *current* `jobKey` to complete
the right Camunda task.

- [x] **`JobRegistry`** (`src/host/src/jobs/job-registry.ts`) — JSONL store
      modelled on `MetricsStore`: `add`/`get`/`search`/`update`, append-one-line
      per change, current state = last line per `jobId` (no rewrite, torn line
      skipped). Persists to `host/jobs/jobs.jsonl` (`HOST_JOBS_FILE` overrides),
      package-root-anchored like appsettings. Added to `MountContext` (the one
      host-owned *service* on the seam, distinct from the bus) + instantiated at
      the composition root.
- [ ] **Agent boundary stays `sessionId`** — *(decision 2026-06-18)* the agent is
      a pure executor that knows **only its own `sessionId`**; it never learns
      `workId`, `jobKey`, or any Camunda field. The agent contract is
      `{ sessionId, input }` in / `{ sessionId, result }` out (`src/agent/src/server/`
      `contract.ts` + `api.ts`); strip `processInstanceKey`/`jobKey`/`jobType` from
      the agent payloads. The host **trusts the returned `sessionId`** because the
      session is authenticated — that's the correlation key on the way back. No
      `workId` rename at the agent (reversing the earlier plan).
- [ ] **Host owns the true session (`workId` binds the three facets)** — `workId`
      is the host's durable key (`jobKey` is Camunda-bound, so it can't be it).
      `agent-client.ts` keys by `workId`, holds `camundaId(processInstanceKey) →
      workId`, `workId → currentJobKey`, and `sessionId ↔ workId`, retiring the
      current `sessionByJob` `jobKey → sessionId` map. The work unit also owns its
      **workspace** — one sandbox dir per `workId`, provisioned at trigger and reused
      for every step (`AGENT_WORKSPACE`/`sandboxRoot` is set per work unit, not
      process-global as `runtime_context` does today).
- [ ] **Workspace as shared blackboard (host-bridged)** *(decision 2026-06-18)* —
      the per-`workId` workspace is the work unit's **data plane**: the agent reads
      and modifies files in it across steps; Camunda "sees" them via the host, since
      Zeebe reasons over **variables, not files**. Two host-mediated directions:
      (a) **agent → Camunda** — on `completeJob` the host lifts *declared* workspace
      artifacts into Camunda variables (e.g. `valid`, `rowCount`, a file ref) so BPMN
      **gateways branch on the agent's output**; (b) **Camunda → agent** — process
      variables seeded at trigger / carried on the job seed the workspace (input
      data, a file reference). Boundary: the agent touches **only its own `workId`
      sandbox**, and **only declared artifacts** cross to variables — never arbitrary
      file contents. (This is the 3-step demo: `setup` writes the user-roster xlsx →
      `update` mutates a row → `validate` reads it back and the host lifts `valid`
      for the BPMN to branch on.)
- [ ] **Local workspace = `workspaces/<workspaceId>` (shared root)** *(decision
      2026-06-18)* — for local dev the host creates a `workspaces/` dir under the
      Agent.Local project root; host/Camunda-side **and** agent both build the path
      as `workspaces/<workspaceId>` from the **host-generated `workspaceId`** (passed
      on `/session/create`), so they resolve the *identical* dir while co-hosted — no
      copying, it IS the shared medium. Behind a thin `Workspace` seam
      (`pathFor`/`read`/`write`/`list`/`dispose`) so the future **cloud bucket** is a
      backend swap, not a rewrite; the variable-lift bridge to Camunda is unchanged
      either way. Replaces the process-global `sandboxRoot` in `runtime_context.ts`.
- [ ] **Host mints `workspaceId`, pushes it down on `/session/create`** *(decision
      2026-06-18)* — the **host generates one `workspaceId` guid per work unit** and
      **passes it into `/session/create`**; the agent uses it to resolve its sandbox
      (`workspaces/<workspaceId>`). This reshapes today's flow, where the agent
      derives the session id (`resolveSessionId` returns the principal, collapsing
      all a principal's traffic to one session) and *returns* it — instead the host
      supplies the workspace locator and the agent honors it. The **same**
      `workspaceId` + session serve every step of the one Camunda run, so files +
      conversation persist across the whole workflow; both retire on
      `workflow.completed`/`failed`. Auth-trust: the workspace is created during the
      authenticated trigger; the agent records the owning principal at create and
      rejects a foreign principal resuming it. *(Open: whether `sessionId` is a
      separate guid or simply equals `workspaceId` — 1:1 either way.)*
- [x] **`+` Trigger endpoint** *(decision 2026-06-18)* — the host-initiated entry
      point, under `/workflow` (host owns `workId`): `POST /workflow/trigger`
      `{ workflowId }` → `202 { workId }`. The trigger, in order: mint `workId` →
      `jobs.add(workId)` (`new`) → **create the agent session up front**
      (`sessionId`, recorded `sessionId ↔ workId`) → start Camunda → wire the join.
      Bus-pure start: trigger `publish`es `workflow.start` `{ workId, workflowId }`;
      the workflow mount subscribes, calls `createProcessInstance`, and replies
      `workflow.started` `{ workId, camundaId }`; the host fills `camundaId → workId`
      + `update(workId, { camundaId, status:'running' })` async. (Invariant holds:
      the host starts a *process*, never dispatches the agent — Camunda still
      initiates every job.) — **landed 2026-06-19**: `Orchestrator.trigger`
      (`src/host/src/orchestrator.ts`) mints `workId`+`workspaceId`, `jobs.add`,
      `agent.createSession(workspaceId, workId, authHeader)` up front, records
      `sessionId`, publishes `WORKFLOW_START`; `POST /workflow/trigger`
      (`src/host/src/index.ts`) returns `202 { workId }` and forwards the caller's
      ticket access token as the agent bearer. `WORKFLOW_STARTED` updater fills
      `camundaId` + flips to `running`.
- [ ] **Wire the updaters** (the lifecycle the registry exists to record):
      - `+` trigger (above) seeds the work unit: `workId`, `sessionId`, `camundaId`.
      - Camunda drives a job (`workflow.job` → `processInstanceKey`, `jobKey`) →
        resolve `workId` via `camundaId` (session already exists), remember the live
        `jobKey`, dispatch `{ sessionId, input }` to the agent,
        `update(workId, { status: 'running', step })`.
      - agent result (the hook → `/receive` → `agent.result`) carries `sessionId`;
        host resolves `sessionId → workId`, `update(workId, { status: 'completed' })`,
        then completes the *current* Camunda `jobKey` for `camundaId`.
      - `workflow.failed` → `update(workId, { status: 'error' })`; a job parked too
        long without progress → `stuck` (timer/heartbeat, can defer).
      - *(partial 2026-06-19)* `Orchestrator.start` wires the terminal folds:
        `WORKFLOW_STARTED → camundaId/running`, `WORKFLOW_COMPLETED/FAILED →`
        resolve by `camundaId`, `closeSession`, set `completed`/`error`. Still
        open: the per-job `workflow.job → running/step` updater and the
        `agent.result → completeJob` return path (host receives via `/receive`).
- [ ] **`description` on the work unit** — add a `description` field to
      `JobRecord` (the user's request text / task summary), set at `add` from the
      create-request flow. The M8-4 jobs table renders it as a column; until set it
      falls back to `jobId`/`step`.
- [ ] **Host `/api/jobs` endpoint** (the surface M8 + web's create-request flow
      use): `GET /api/jobs` (search, optional `?status=`), `GET /api/jobs/:jobId`
      (current state), `POST /api/jobs` (save — create/update a work unit),
      `POST /api/jobs/:jobId/cancel` (M8-4 cancel → `cancelled` + halt the Camunda
      instance via M7-1). Thin router over `JobRegistry`
      (`add`/`get`/`search`/`update`), mounted before web's SSR catch-all so it
      isn't shadowed.
- [ ] Tests: `add` then fold returns the seeded record; a sequence of `update`s
      yields the last-line state; `search({status})` filters; a full
      `new → running → completed` lifecycle reconstructs from the JSONL; an
      `agent.result` for an unknown `sessionId` is a no-op, not a throw.

**Done when:** a request creates a work unit the host can list/search; a Camunda
job advances it to `running` with `camundaId`/`step`/`sessionId` recorded; the
agent's `sessionId`-keyed result resolves to its `workId`, flips it to `completed`,
and completes the correct Camunda job — with the agent carrying no Camunda-shaped
field, only its own `sessionId`.

### M7-8 · Host-owned IAM — login, JWKS, encrypted session cookie + agent JWT trust — `~2d` · P1
The auth seam that lets the browser, the host, and the agent share one identity
without the agent ever sharing a secret with the host. **The host owns IAM**; the
browser authenticates to the host with a cookie; the host↔agent hop is a bearer
JWT the agent verifies via **standard JWKS**. Browser↔host secrecy and host↔agent
trust are deliberately different mechanisms (opaque encrypted cookie vs. signed
JWT) so a browser can never replay an agent-facing token and the agent never holds
a cookie key. Prerequisite for M7-5 (Camunda IAM identity) and overlaps M2-1
(agent-side JWKS verification — landed here for the host-issued token).

- [x] **Host RS256 key ring + login.** `loadOrCreateKeyRing` (`src/host/src/user/keys.ts`)
      loads/first-run-generates the signing ring; `UserRegistry`
      (`src/host/src/user/userRegistry.ts`) is the local credential store;
      `POST /api/login` (`src/host/src/api/auth.ts`) verifies creds and mints an
      RS256 access token (2h) carrying `sub`/`userName`/`permissions`, each token
      stamped with the signing key's `kid`.
- [x] **Standard JWKS endpoint.** `GET /.well-known/jwks.json` publishes the whole
      ring as JWKs (`publicJwk` in `@agent-local/common`, RFC 7638 thumbprint `kid`,
      `use:sig`/`alg:RS256`) so a rotation keeps verifying in-flight tokens. The
      agent validates host JWTs via `createRemoteJWKSet` — no shared secret.
- [x] **Encrypted cookie = authentication ticket.** `sealTicket`/`openTicket`
      (`@agent-local/common/jwt`, `jose` `dir`/`A256GCM`, key = `sessionKey` =
      SHA-256 of `host.session.secret`) wrap `{ accessToken, claims, authenticated }`
      into an httpOnly, `SameSite=Lax`, 2h cookie opaque to the browser.
      **Encrypt-at-response** (`/api/login` seals + `Set-Cookie`),
      **decrypt-at-middleware** (`sessionMiddleware`, `src/host/src/user/session.ts`,
      opens it ONCE → `req.authTicket`; missing/tampered/expired → unauthenticated).
      `GET /api/me` returns claims; `POST /api/logout` clears it. Cookie `maxAge`
      mirrors the ticket exp so both go stale together.
- [x] **Host identity middleware + guard.** `userContextMiddleware`
      (`src/host/src/user/userContext.ts`) resolves a presented bearer (verified
      against the host's own ring via `createLocalKeyResolver`) OVER the session
      ticket → `req.userContext`; `requirePermission(p)` is the route guard
      (401 unauth / 403 missing permission).
- [x] **Service tokens (client-credentials).** `POST /api/auth/token` takes HTTP
      Basic `clientId:secret` → short-lived (15m) RS256 JWT for service-to-service
      calls (the agent presents it as a bearer); no cookie, no scope negotiation.
- [x] **Agent verifies host JWT via JWKS.** `src/agent/src/server/auth/jwks.ts`
      (`createJwksProvider`) + `src/agent/src/server/middleware/user_context.ts`
      verify the bearer (signature/`kid`/`iss`/`aud`/`exp`) against the host JWKS;
      `/session/create` and job dispatch are gated on `executework`. *(satisfies the
      agent-side half of M2-1 for the host-issued token; external-OIDC verification
      in the CLI runtime stays open under M2-1.)*
- [x] **Web drives off the cookie, localStorage removed.** `login`/`profile`/
      `UserMenu` read identity from `/api/me`; sign-out posts `/api/logout`; the
      old localStorage `token.ts` was deleted. SSR hydrates identity from the
      ticket via the `resolveUser` seam (`src/web/src/server/mount.tsx`).
- [ ] **Secrets out of `appsettings`.** `host.session.secret` and the signing key
      ring are dev-local today (the host warns when the secret is absent and falls
      back to an insecure dev key). Move both to a real secret store before any
      non-local deploy.
- [ ] **Agent session ownership binding (M2-2).** A foreign principal must not
      resume another's agent session — bind `session.user.sub` on create and refuse
      mismatched resume; today the agent trusts the returned `sessionId`.
- [ ] **CSRF posture review.** Cookie is `SameSite=Lax` + httpOnly; confirm that is
      sufficient for the state-changing `/api/*` + `/workflow/trigger` POSTs or add
      a token-header check before exposing beyond local dev.

**Done when:** *(met 2026-06-19 for local dev)* a browser logs in and gets an
opaque encrypted cookie (no token in the response body); `/api/me` decrypts it;
`/api/logout` and expiry both drop to signed-out; the host forwards the ticket's
access token as a bearer the agent validates via `/.well-known/jwks.json` (verified
`/session/create` → 201); cookie + JWT both expire at 2h. Open bullets above gate
the non-local hardening.

### M7-9 · `src/temporal` — Temporal as an alternative workflow engine behind the same mount seam — `~2.5d` · P2
Prove the M7 thesis ("**the bus is the seam — engines talk only through it**") by
adding a SECOND workflow engine that the host can mount **instead of** Camunda,
with zero change to the agent or the bus contract. Camunda is BPMN-first
(broker + deployed `.bpmn` + job workers polling a task type); Temporal is
code-first (Temporal Server + TypeScript workflows/activities via
`@temporalio/worker`/`@temporalio/client`). The two are interchangeable precisely
because the host only ever sees a `mount(app, ctx)` that publishes/subscribes the
engine-neutral bus vocabulary — `mount.ts` is the glue, not a Camunda detail.
- [x] New workspace `@agent-local/temporal` (`src/temporal`) exposing the **same**
      `mount(app, ctx: MountContext): TemporalClient` contract as `@agent-local/workflow`
      (`src/workflow/src/mount.ts`) — same `{ bus, logger, signal, settings }` in,
      same control surface (`POST /workflow/process`, `GET /workflow/process/:key`,
      `GET /workflow/healthz`). Registered in the root workspaces array. — **landed
      2026-06-19** (scaffold): `mount.ts`/`temporal-client.ts`/`config.ts`/`index.ts`/
      `main.ts` mirror the workflow package; `MountContext` kept local for now (lifting
      the shared `EngineClient`/`MountContext` to `@agent-local/common` + the host
      `WORKFLOW_ENGINE=camunda|temporal` switch are the deferred "add workflow later").
      **Update 2026-06-19:** in the live run Temporal is now the **default** engine, not
      a behind-a-switch alternative — the host dropped its `ZEEBE_ADDRESS`/`26500`
      fallback and reads only `TEMPORAL_ADDRESS` (see M7-10). The `WORKFLOW_ENGINE`
      camunda↔temporal toggle stays deferred; Temporal is just the default path until it lands.
- [ ] Speak the identical bus events — subscribe `workflow.start` / `workflow.stop`
      / `workflow.inject` / `workflow.retry` / `agent.result`; publish
      `workflow.started` / `workflow.failed` / `workflow.job`. The agent and mesh
      stay oblivious to which engine is mounted (the M7-3 invariant: Camunda/Temporal
      always initiates, the agent only answers jobs). This is the whole point — the
      payload shapes don't change, only the engine behind them.
- [ ] Concept mapping (isolate Temporal-specifics in a `TemporalClient` mirroring
      `ZeebeClient`, so `mount.ts` stays engine-shaped, not SDK-shaped): BPMN process
      → a TS **Workflow**; the `agent-execute` service task → an **Activity** that
      fire-and-forgets the dispatch (publishes `workflow.job`) while the Workflow
      `await`s; `processInstanceKey` → `workflowId`/`runId` as the execution id;
      `cancelProcess` → `WorkflowHandle.cancel()` (terminate = forceful);
      `setVariables` (inject) → a Temporal **Signal**; `retryJob` → Temporal's
      built-in activity retry policy / `resetWorkflow`; single-instance state read
      (`getInstance`) → `WorkflowHandle.describe()`; in-flight state → `query()`.
      **No list method on the client** — listing is a host concern (next bullet).
- [ ] **Agent reports, workflow decides — NOT "agent completes a job"** *(decision
      2026-06-19)*. The agent never decides doneness; it emits task results and the
      **Workflow code** figures out if the work is done and what's next. So
      `agent.result` is a **Signal** carrying the result (`reportResult(workId, result)`
      → `handle.signal("agentResult", result)`), NOT async activity-completion: the
      Workflow `await`s the signal, inspects the result, and loops (dispatch again) /
      branches / returns from its own logic. This also keeps the seam user-scopable —
      a signal is keyed by `workId` (host-owned, user-mapped), whereas an opaque
      Temporal task token is un-authorizable.
- [ ] **TemporalClient is stateless + user-agnostic; ownership lives at the host**
      *(decision 2026-06-19)*. The client is a thin engine adapter keyed only by
      `workflowId`/`runId` — no `userId`, no Temporal search attributes, no namespace
      setup. Every call it receives is **already authorized** by the host
      (`Orchestrator`'s existing `record.userId !== userId` gate). Drop the local
      `instances` Map the `ZeebeClient` keeps (Temporal `describe()` is authoritative
      for one instance; nothing replaces the Map engine-side).
- [ ] **List active tasks by user = host/registry, not the engine** *(decision
      2026-06-19)*. "Get the user's active works" is served from the host
      `JobRegistry` (already user-keyed: `jobs.search({ userId, status: "running" })`),
      since it persists `workId → userId` + folded status. The engine is consulted
      only for authoritative live status of a single already-authorized work via
      `getInstance(workId)`. (Temporal visibility `list()` with a `userId` search
      attribute stays a possible later cross-check, not the primary path — avoids
      depending on visibility indexing being registered.)
- [ ] Proposed `TemporalClient` surface: `start(type, args, { workflowId })`,
      `cancel(workflowId)` / `terminate(workflowId, reason)`, `getInstance(workflowId)`,
      `signal(workflowId, name, payload)`, `query(workflowId, name, args?)`,
      `reportResult(workflowId, result)`, `connected`, `start()`/`stop()` — no
      list, no userId.
- [ ] **Prove first, rename later — don't gate the PoC on the leak.** `camundaId`
      and the `workflow.*` / `agent.job` field names are Camunda-shaped today (M7-6's
      host map keys by `camundaId → workId`). For this proof, just **reuse the
      existing id field** — Temporal populates `camundaId` (and `job`/`jobKey`,
      whatever the bus already carries) with its `workflowId`/`runId`; the host
      correlation map is untouched. Getting two engines running over the unchanged
      contract is the point. The engine-neutral rename (`camundaId → executionId`
      across bus + host map) becomes a justified, mechanical follow-up *once* the
      second engine has demonstrated the seam — not a prerequisite for it.
- [ ] **Engine auth = the host's OWN service identity, validated against the host JWKS —
      NOT the frontend user's token** *(decision 2026-06-19)*. Temporal is a one-way gRPC
      *pull*: the worker dials the server (`:7233`) and long-polls; there is **no inbound
      surface** to expose and nothing Temporal calls back into (the "function outside the
      runtime" is an **Activity**, run in our worker, not a webhook). The only auth is the
      host→Temporal hop, and it is **service-to-service**:
      - The host mints a **fresh, short-lived service token under its own service user**
        (mirror `HttpJobSender.fetchToken`'s client-credentials → mint-per-call → discard),
        sets it as gRPC metadata, refreshes before expiry (~1h) on the reconnect loop.
      - Temporal validates it with its **built-in JWT authorizer** pointed at the host's
        existing `/.well-known/jwks.json` (`global.authorization.jwtKeyProvider.keySourceURIs`)
        — RS256 matches the host key ring, so **zero custom Go plugin** if the service token
        carries a Temporal-shaped `permissions` claim (`["default:write"]`, or
        `temporal-system:admin` for control-plane). A custom `ClaimMapper` is the fallback
        only if we want to keep the host's own claim vocabulary (costs a custom server build).
      - **Two token planes never mix:** `workflow:read/write` etc. are **frontend rights** on
        the *caller's* user token (web console / works API gate) and never reach the engine;
        the Temporal `permissions` claim rides only the host's service token. Don't rename the
        frontend scopes to Temporal's format — the agent + works hops depend on them.
      - **mTLS is a prod/Cloud concern, not local.** Local = plaintext (mirror Zeebe dev:
        `CAMUNDA_SECURE_CONNECTION=false`). Self-hosted prod = private-CA client cert (Let's
        Encrypt issues only `serverAuth`, never the client cert). On GCP, a self-hosted server
        can instead consume the Cloud Run SA's Google OIDC token via a ClaimMapper. **Temporal
        Cloud** takes mTLS cert / API key only — it won't trust our JWKS (IAM just guards the
        stored secret). All transport/auth comes from env, no secrets inline.
- [x] **First code-first Workflow + test landed — 2026-06-19.** `src/temporal/src/workflows/`:
      `user-table-test.ts` (initialize → create users sheet → add userId=55/foxmulder →
      assert row → return *"user table created"*; agent answers each step via the `agentResult`
      signal, the Workflow decides done/next) + `activities.ts` (`createAgentActivities(bus)`
      binds the host bus into the dispatch Activity so the Workflow stays pure). Proven by a
      `@temporalio/testing` time-skipping test with the dispatch mocked (9 passing, `tsc`
      clean). `userId=55` is domain **test data**, not the principal owner. Still deferred:
      `worker.ts`, the real `TemporalCore`/SDK adapter, and running it against a live server.
- [ ] Self-managed Temporal Server alongside the Zeebe broker pattern: a
      `docker-compose` service (Temporal + its datastore, UI optional/commented like
      Operate), endpoint + namespace + auth from env via an engine-agnostic
      `loadConfig` (reuse `src/workflow/src/config.ts`'s env-only, no-secrets-inline
      rule; Temporal Cloud = same client, different endpoint/mTLS).
- [ ] Resilience parity with M7-1: reconnect-with-backoff, graceful `stop()` on
      `ctx.signal` that never throws, server-down-at-boot does not crash, the same
      `/workflow/healthz` contract (folded into the host composite `/healthz`).
- [x] Tests against an **injected fake** Temporal core (mirror M7-1's fake gRPC —
      no server required): startProcess keys by our workId; getInstance reads
      `describe()`; reportResult signals `agentResult` and does NOT publish
      `workflow.completed` (the workflow decides done/next); setVariables → `inject`
      signal; cancel routes to the handle; server-down-at-boot does not crash;
      allowlist refusal. — **landed 2026-06-19**: 7 passing tests in
      `src/temporal/src/tests/temporal-client.test.ts`; `tsc --noEmit` clean. Defer
      the live `TestWorkflowEnvironment` E2E (real server) like the Camunda one.

**Done when:** with `WORKFLOW_ENGINE=temporal` the host mounts `@agent-local/temporal`
and the SAME `Camunda job → agent execute → result → job complete → process advances`
cycle (here: `Temporal workflow → Activity dispatch → agent reports result via signal
→ the Workflow decides done/next → workflow advances`) runs end-to-end over the
unchanged Eventing bus, with no edit to `@agent-local/agent` or the bus event shapes —
demonstrating the mount seam is engine-agnostic; and the user's active works are
listable from the host `JobRegistry` (user-keyed), not from the engine.

### M7-10 · `src/temporalhost` — self-managed Temporal Server runtime (mirror `camundahost`) — `~1d` · P2
Extracts the deferred "Self-managed Temporal Server" bullet of M7-9 into its own
**deploy-only** workspace, exactly as `@agent-local/camundahost` is the Zeebe
broker runtime behind `@agent-local/workflow`'s client. The existing
`@agent-local/temporal` client stays the *client*; this is only the *server* it
points at via `TEMPORAL_ADDRESS`. **No Node/agent code** — docker-compose + config.
> **Live in `npm start` — 2026-06-19** (commit "with temporal live container"):
> `scripts/start.sh` `ensure_temporal()` now brings the container up before host/agent
> AND pings the **published** `:7233` gRPC port from the host (not just in-container
> health) so the 7233 mapping is confirmed reachable by the clients. The host defaults
> its engine to Temporal — `health.ts`/`index.ts` dropped the `ZEEBE_ADDRESS`/`26500`
> fallback; `TEMPORAL_ADDRESS` (default `localhost:7233`) is the sole engine endpoint.
> **Remaining:** the worker-driven live E2E bullet below.
- [x] New workspace `@agent-local/temporalhost` (`src/temporalhost`), registered in
      the root `workspaces` array next to `camundahost`. Deploy-only, **same layout as
      camundahost**: `Dockerfile`, `dockerfiles/startup.sh`, a local **`config/`**
      folder (baked-in server config), `docker-compose.yml`, docker `scripts`
      (`docker:build` with a version `--build-arg`, `docker:up`/`docker:down`/`docker:logs`),
      no `src/`, no Node/agent code. — **landed 2026-06-19** (scaffold, unbuilt).
- [x] **Custom image** `FROM` a pinned `temporalio/auto-setup:${TEMPORAL_VERSION}`
      base (build arg), then `COPY config/dynamicconfig/agent-local.yaml` +
      `dockerfiles/startup.sh` in **after the fact** from the local `config/` folder,
      exactly as camundahost copies `application.yaml`. The `startup.sh` wrapper applies
      env-overridable dev defaults (`DEFAULT_NAMESPACE=default`, `BIND_ON_IP=0.0.0.0`,
      postgres datastore, `DYNAMIC_CONFIG_FILE_PATH`) then `exec`s the base auto-setup
      entrypoint (schema init + default namespace + server). gRPC `:7233`. — **landed
      2026-06-19**. (Override the full `config_template.yaml` only if a dev needs more
      than dynamic config — auto-setup ships a working template by default.)
- [x] `docker-compose.yml` runs the **built** image plus its datastore: a Postgres
      service (the schema-init auto-setup performs at boot, gated on a `pg_isready`
      healthcheck), and `temporalio/ui` for the Web console **commented/optional** like
      camundahost's Operate block. `default` namespace registered by auto-setup on first
      boot. Temporal Cloud = same client, different endpoint/mTLS — this host is then
      unused. — **landed 2026-06-19**.
- [x] **No workflow definitions in the server image** (the camunda BPMN divergence):
      Temporal is code-first, so the server holds no process state. The worker that
      registers `workflows/` + activities is the deferred bit of the **client**
      (`@agent-local/temporal`), NOT this host — the runtime stays a pure server, the
      same way the broker image stays a pure runtime with no BPMN baked in.
- [x] Endpoints/secrets env-only (M7-1 rule): compose carries only non-secret dev
      defaults; namespace/address/datastore arrive from env so the same image runs
      unchanged against a remote datastore.
- [x] Healthcheck on the gRPC frontend (`:7233`) folded into compose (`tctl cluster
      health`), mirroring camundahost's `:9600` TCP check.
- [x] **Local-authority auth wiring (the M7-9 decision made concrete) — 2026-06-19.**
      Temporal trusts `src/host` as the authority via its built-in JWT key provider +
      default claim mapper + default authorizer (**zero Go plugin**): `config/base_template.yaml`
      carries only `global.authorization` and is merged AHEAD of the auto-setup-rendered
      `docker.yaml` (Temporal loads `base.yaml` first, field-by-field merge) — so we add auth
      without forking the ~200-line upstream `config_template.yaml`. `startup.sh` renders it with
      `dockerize` so the JWKS endpoint stays env-driven (`TEMPORAL_JWKS_URI` →
      `http://host.docker.internal:3011/.well-known/jwks.json`, `TEMPORAL_PERMISSIONS_CLAIM=permissions`).
      Off by default (`TEMPORAL_AUTH_ENABLED=false`) so `docker:up` is green standalone; compose
      ships the env + `extra_hosts: host.docker.internal:host-gateway` (Linux parity) ready to flip.
      With auth on, the default authorizer denies auto-setup's un-tokened `tctl namespace register`,
      so `startup.sh` auto-sets `SKIP_DEFAULT_NAMESPACE_CREATION` — `default` is registered once with
      an admin-claim (`temporal-system:admin`) host token (README). Honors M7-9's two-token-planes
      rule: the host mints its OWN service token with a Temporal-shaped `permissions` claim
      (`<namespace>:<role>`, e.g. `default:write`); the frontend `workflow:read/write` scopes never
      reach the engine. Client token-sending stays the deferred `@agent-local/temporal` worker bit.
- [ ] Wire the live E2E that M7-9 deferred: with `temporalhost` up and
      `TEMPORAL_ADDRESS=localhost:7233`, the `@agent-local/temporal` worker (once
      built) runs `user-table-test` against the real server — the live-server parity
      item that mirrors M7-1's live-broker E2E.

**Done when:** `npm run docker:up -w @agent-local/temporalhost` brings up a Temporal
Server reachable on gRPC `:7233` with the Web UI on `:8233` and the `default`
namespace present; `@agent-local/temporal` connects via env with no code change;
secrets/endpoints stay env-only; no workflow definitions live in the server image.

### M7-11 · `temporalhost` productionalization — external Postgres + split schema migration — `~1.5d` · P3
Promotes M7-10 from the self-contained local stack (bundled, **ephemeral** Postgres,
boot-time auto-setup) to a deploy-shaped server backed by a **managed/external
Postgres**. The image does NOT change — datastore endpoint/creds are already env-only
(M7-10) — so this is operational wiring, not new bake. The local `docker:up` path
stays exactly as-is and untouched: this story is the prod overlay only.
> **Adjacent landed 2026-06-19** (commit "with temporal live container"): a standalone
> **`src/postgres`** workspace (`@agent-local/postgres`) — local Postgres + pgAdmin,
> deploy-only, **NOT** part of the app lifecycle (`npm start` doesn't touch it). Config
> (`postgresql.conf`/`pg_hba.conf`) is baked into the image; pgAdmin auto-registers the
> server; env-overridable creds/ports; `npm stop -- --wipe` drops the volume. It is an
> **ad-hoc query stack**, not the managed datastore this story provisions and not the
> memomcp pg repository (M3-12) — but it's the local-Postgres-runtime precedent both lean on.
- [ ] **Datastore is external, not in the stack.** Drop the bundled `postgresql`
      compose service in the prod overlay; point the server at a managed Postgres via
      the existing env (`POSTGRES_SEEDS`/`DB_PORT`/`POSTGRES_USER`/`POSTGRES_PWD`, TLS
      knobs). Local compose keeps the bundled DB for dev.
- [ ] **Provision role + databases out-of-band** (the managed-DB login is usually NOT
      a superuser, so auto-setup's `CREATE DATABASE` can't be relied on): pre-create the
      `temporal` role + the two databases (`temporal`, `temporal_visibility`) and grant
      the role on them. Capture as a one-time provisioning snippet, not a `startup.sh`
      step — the image stays a pure runtime.
- [ ] **Schema migration as a separate one-shot job, NOT on every boot.** Stop relying
      on `autosetup` to migrate a shared DB on each server start; run `temporal-sql-tool
      setup-schema`/`update-schema` against the two DBs as a dedicated migrate job (CI
      step or init container) that runs once per version bump. The server then boots with
      a non-`autosetup` `CMD` (schema already present), removing the boot-time DDL race
      when multiple replicas start.
- [ ] **Namespace bootstrap is explicit** (no auto-register): register `default` (and
      any others) once with an admin-claim host token, consistent with the auth-on path
      M7-10 already documents (`SKIP_DEFAULT_NAMESPACE_CREATION`).
- [ ] **Durability + backup** are the managed DB's job: document that workflow history
      now survives `down`/`up` (no ephemeral volume), and that PITR/backup is delegated to
      the managed Postgres — the dev caveat (bundled DB has no volume) no longer applies.
- [ ] Capture the split in the README "external Postgres" section (provisioning snippet +
      migrate-job command + non-`autosetup` boot), and add a stubbed migrate step to
      `.github/workflows/temporalhost.yml` next to the build job.

**Done when:** the prod overlay boots `temporalhost` against a managed Postgres with
schema applied by a separate migrate job (server `CMD` ≠ `autosetup`), `default`
registered explicitly, history surviving a server teardown — while `npm run docker:up
-w @agent-local/temporalhost` still runs the bundled-DB dev stack unchanged.

---

## M8 — Frontend epic (React console + API)

A web console for the co-hosted express process (D6): a React app plus the
express API it consumes, to *start and watch* workflow instances and the agent
runs they drive. Served by the same express process for now — one deployable,
consistent with the co-host decision — split out only when the backend does.

**Stack mirrors the `Rxo.Platform.Web.Sandbox` frontend** (verified against the
live `src/frontend/package.json` on disk — the indexed skill doc was stale):
React 19 + react-router 7, built with **Webpack 5 + Babel** (`webpack.dev.mjs` /
`webpack.prod.mjs`), an express server host under `src/server/` that serves the
build and tunnels `/api`, an `api_module/` typed client **generated from the
OpenAPI spec** (`openapi-typescript -g typescript-fetch`) consumed via an
**axios** factory + domain hooks, and **OIDC** (`express-openid-connect` server
middleware + `oidc-client-ts`). Two deliberate divergences from the sandbox: the
`/api` tunnel targets **our express** (M4-1/M7-1), *not* a .NET backend — no .NET
in this epic; and the component library is **Material UI (MUI)**, *not* the
sandbox's `styled-components` + `@reliability-design/*` (an internal RXO design
system out of scope here). The host does **streaming SSR**
(`renderToPipeableStream`, dual client+server webpack bundles) like the sandbox —
chosen over plain CSR to keep the convention intact.

The sandbox is a **copy-and-adapt bootstrap reference, not a dependency** — we
lift its webpack/server/gen wiring into `@agent-local/web`, modify freely, and
index *our own* workspace into the local codemcp once scaffolded.

The console is a **read/observe + initiate** surface, not a new control plane: it
calls the existing M4-1 (agent sessions/dispatch) and M7-1 (process start/state)
endpoints, and renders the live `Eventing` stream. It must respect the M7
invariant — the UI can start a *process*, never dispatch the agent directly.

Depends on: M4-1 (SSE transport + runner-event payloads), M7-1 (process
control surface + the express host to mount on), M7-3 (the bus root to stream
from).

### M8-2 · Express API (OpenAPI) + bus→browser bridge — `~2d` · P1
A thin BFF on the express host, layered over the existing endpoints, **described
by an OpenAPI/swagger spec** the frontend generates its typed client from — plus
the live event stream the UI renders.

> **Revised 2026-06-19 — auth + transport replaced.** OIDC was superseded by host-owned
> cookie-ticket auth + JWKS (M7-8); the **SSE bus bridge was removed for now** — it was
> unauthenticated and broadcast-to-all (every client saw every tenant's events, no per-user
> scope), so it was deleted in favour of **cookie-scoped refetch**. What landed instead: the
> user-scoped **works API** — `GET /api/works` (search), `GET /api/works/:id` (get),
> `POST /api/works` (create → trigger flow), `POST /api/works/:id/stop` — each gated by
> `requirePermission` and scoped to the cookie identity (`src/host/src/api/works.ts`). The live
> event stream is **deferred** (future re-add, SSE or WebSocket). Still open: the OpenAPI/swagger
> spec + generated typed client (the `api_module/` + axios machinery).
- [ ] BFF endpoints on the express host (`src/web/src/server/`): list/start
      process instances (proxy M7-1), list/read agent sessions (proxy M4-1) —
      shape responses for the view, don't reimplement engine logic.
- [ ] Publish an OpenAPI/swagger spec for these endpoints; generate the client
      with `openapi-typescript -g typescript-fetch` into `src/web/src/api_module/`
      via an `npm run gen` script (mirrors the sandbox's `gen` flow), consumed
      through an **axios** factory + domain hooks — `api_module/` is generated,
      never hand-edited.
- [x] ~~Bus→browser bridge: subscribe the express handler to the `Eventing` root
      and stream events to the browser as **SSE**~~ — **removed 2026-06-19**: the SSE
      bridge (`events_sse.ts`, `/events`, `eventing_context`) was deleted; the console
      refetches the works API on load + a Refresh button instead. Live stream revisited later.
- [ ] Correlation passthrough: each streamed event carries its
      `processInstanceKey` / `sessionId` so the client can route it to the right
      view without a second lookup.
- [x] ~~OIDC auth mirroring the sandbox~~ — **superseded 2026-06-19 (M7-8)**: host-owned
      encrypted cookie ticket + JWKS, not OIDC. Every works route reads the resolved
      `req.userContext` and 401/403s via `requirePermission` — "no anonymous console in
      service mode" (D4) is met for the works surface.
- [ ] Test: a published bus event reaches an SSE client; a started process via
      the BFF returns the instance key from M7-1; the generated client compiles
      against the published spec.

**Done when:** the React app authenticates via OIDC, calls the express API
through its generated typed client, opens one SSE connection, and renders live
`workflow.job` / `agent.result` events as they bubble the bus — and can start a
process instance.

### M8-3 · React console components (workflow + agent views) — `~2.5d` · P1
The actual feature components — MUI, react-router 7 routes — against the M8-2
generated `api_module/` (via axios hooks) + SSE hook.
- [ ] Process view: list instances + state (M7-1), a "start process" form, and a
      per-instance timeline that updates from the SSE stream as jobs fire and
      complete.
- [ ] Agent run view: for a dispatched job, render the streamed runner events
      (dispatch → tool calls → verdict → result) live — reuse the event `type`
      taxonomy the CLI renderer already switches on, don't redefine it.
- [ ] Session list + detail: summaries (M4-1 `GET /sessions`) and a read-only
      transcript view of a selected session.
- [ ] Components are presentational over the generated client + SSE hook; no
      engine or bus logic in the browser — it observes and initiates only (M7
      invariant).
- [ ] Smoke: starting a process from the UI shows its instance appear, an agent
      run stream, and the instance reaching its end event — end-to-end through the
      co-hosted process.

**Done when:** a user starts the M7-1 sample process from the console and watches
the full `Camunda job → agent execute → result → process advances` cycle render
live in the browser, sourced entirely from the SSE bus bridge.

### M8-4 · Jobs table view — list work units + cancel — `~1d` · P1
A simple table over the host's `/api/jobs` (M7-6): one row per work unit so a user
can see what is in flight and stop a run. The minimal observe surface for the
work-unit aggregate, distinct from the M8-3 live timeline — this is the flat
"what jobs exist and what's their status" list.

> **Largely landed 2026-06-19 as `/api/works`** (the endpoint is `/api/works`, user-scoped, not
> `/api/jobs`). `src/web/src/pages/workflow.tsx` renders a works table (Work · Status · Step ·
> Camunda · Agent session · Updated · Stop) off `searchWorks`/`getWork`
> (`src/web/src/components/shared/worksApi.ts`); a per-row **Stop** → `POST /api/works/:id/stop`
> cancels the Camunda instance (new `workflow.stop` event → `ZeebeClient.cancelProcess`), closes
> the agent session, and sets `stopped` with a reason. Rows refresh via a manual **Refresh**
> button (refetch the list or the opened work) — NOT the SSE stream (removed, M8-2). `JobRecord`
> now carries `userId` (owner, set from the cookie at create). Still open: a `description` field,
> status filter chips, and the OpenAPI/axios typed client.
>
> **Actions landed 2026-06-19**: the per-row action cell is now three MUI `IconButton`s — **Stop**
> (`StopCircle`, on `new|running|stuck`), **Continue** (`PlayArrow`, on `stuck` only), **Refresh**
> (`Refresh`, any status, re-GETs just that row). **Continue** = engine **Reset** to the last
> workflow-task boundary, re-running the stuck step with the same inputs — new `WORKFLOW_RESET` bus
> event → `TemporalClient.resetProcess` → `workflowService.resetWorkflowExecution`; `POST
> /api/works/:id/continue` (404 non-owner, 409 unless `stuck`). Added `@mui/icons-material`.
>
> **Status model cleaned up 2026-06-22 — exactly 4 STORED statuses, recalculated, never latched.**
> The status vocabulary above (`stopped`/`stuck`/`cancelled`/`paused`) collapsed to a single canonical
> set defined ONCE in `src/host/src/work/work-status.ts` (`WORK_STATUS_CODES` drives the `WorkStatus`
> type, the `work_status` DB lookup seed, AND `isTerminalStatus`):
> - **`new`** (neutral/grey) — provisioned, no engine instance yet.
> - **`running`** (active/blue) — a live workflow (`WORKFLOW_STARTED`).
> - **`attention`** (warning/orange) — the single NON-terminal stopped state: any stop or end that
>   isn't a clean completion — user Stop, engine canceled, `WORKFLOW_FAILED`, or reconcile finding
>   failed/timedOut/terminated. Recovered via engine Reset. The ACTUAL per-step Temporal status
>   (`canceled` etc.) shows at the STEP (accordion), never as a work status — the work only says
>   "stopped, needs attention". A clean stop carries NO description (`step=null`); a failure keeps the
>   engine reason.
> - **`complete`** (success/green) — the clean end (`WORKFLOW_COMPLETED`); the ONLY terminal status.
>
> Key behaviors:
> - **`attention` is STORED, set by the event fold — not derived at read.** The list (`GET /api/works`)
>   is a PURE DB read with ZERO per-row engine calls; `getSteps` fires only on detail/expand. Colors the
>   row the moment the stop/failure event lands.
> - **Status RECALCULATES on every poll — it does not latch.** `reconcile` (`work-service.ts`) recomputes
>   each non-terminal work against live engine truth both directions: an `attention` work returns to
>   `running` when its workflow is active again (e.g. later steps fire after an earlier one was canceled);
>   a `running` work the engine cancels/fails becomes `attention`. Only `complete` is never re-evaluated
>   (`needsReconcile` = `status !== "complete"`). A fresh `new` work is guarded from a transient
>   `missing`→`attention` flip.
> - **Stop is PURE CANCELLATION.** `workService.stop` cancels Temporal steps + closes the agent session
>   and writes NO status; the engine's cancel confirmation (`WORKFLOW_STOPPED`/reconcile) folds the work
>   to `attention`.
> - **`complete` is fully locked at BOTH UI and server.** No Stop/Continue/Rerun/Inject/Retry/Chat on a
>   complete work — UI disables the action bar; the server gates every mutation route on `isTerminalStatus`
>   (`work-service.ts` + `api/agent-cli.ts` return 409). **Continue** is offered only on `attention`
>   (`POST /api/works/:id/continue` → 409 unless `attention`).
> - Web maps the host's presentation-neutral `tone` → MUI chip color in `workflow.tsx`
>   (`neutral→default/grey`, `active→info`, `attention→warning`, `success→success`); the per-step
>   accordion keeps its own engine-status tones (`stepToneColor`).

| jobId | status | description | action |
|-------|--------|-------------|--------|
| …     | running| "…"         | Cancel |

- [ ] MUI table component (react-router 7 route, e.g. `/jobs`) reading
      `GET /api/jobs` through the M8-2 generated client + axios hook; optional
      `?status=` filter chips. Rows refresh from the SSE stream (M8-2) so a status
      change (`running → completed/error/cancelled`) repaints without a reload.
- [ ] Columns: `jobId`, `status` (MUI chip colored by state), `description`, and
      an **action** cell. `description` reads the work unit's `description` —
      requires adding that field to `JobRecord` (the user's request text / task
      summary), tracked back in **M7-6**; until it exists the column shows the
      `jobId`/`step` as a fallback.
- [ ] **Cancel action**: a Cancel button on non-terminal rows → `POST
      /api/jobs/:jobId/cancel`, which sets the work unit `cancelled` AND cancels
      the Camunda instance via the M7-1 control surface (cancelling a *process* is
      allowed under the M7 invariant — the UI initiates, never dispatches the agent
      directly). Button disabled/hidden for terminal states
      (`completed`/`error`/`cancelled`).
- [ ] Presentational only — over the generated client + SSE hook, no engine/bus
      logic in the browser (M8-3 rule).
- [ ] Smoke: the table lists seeded jobs, a status chip updates live off the SSE
      stream, and Cancel flips a running job to `cancelled` and halts its instance.

### M8-5 · Per-step breakdown — one row per workflow step — `~1.5d` · P2
Today the works table is **one row per work**, off the host's single `JobRecord.step`
(the current element). A workflow runs several steps internally (`userTableTestWorkflow`:
initialize → create sheet → add row → assert → done), but the host only ever sees the
*current* one. This story breaks a work into **per-step rows**, each with its own status
and its own Continue (re-run just that step).
- [ ] Source the step list from Temporal **event history** (`WorkflowHandle.fetchHistory`),
      not `describe` (which returns only current state): enumerate `ActivityTaskScheduled`/
      `Started`/`Completed`/`Failed` events into an ordered per-step status list.
- [ ] Expose it host-side without breaking bus-purity — a new describe-style round-trip
      (`workflow.describe` → a richer `workflow.status` carrying the step array), folded
      onto the record (or a sibling store) the works API returns.
- [ ] Web: expandable work row → child step rows (step name · status · Continue), the
      Continue here Resetting to **that step's** workflow-task rather than the last one
      (refine `TemporalClient.resetProcess` to take an explicit reset target).

**Done when:** a stuck multi-step work expands to per-step rows showing which step failed,
and Continue on a step re-runs from exactly that step with its original inputs.

**Done when:** the console renders a `jobId | status | description | action` table
sourced from `/api/jobs`, rows update live as work units change state, and Cancel
stops a running work unit and its Camunda instance.

### M8-6 · User chat popup on a work item (first-class `session` + `sessionConversation`) — `~2d` · P2
A user-driven chat against a work item's workspace, separate from the workflow's
own session but sharing its `workspaceId`, so the user can inspect/modify the
work's files conversationally. Modelled as a first-class standalone session that
outlives the workflow run. Concurrency with a live workflow session is left to
the user (no read-only/blocking gate).

> **Reshaped 2026-06-21 — first-class `session` table, not a `JobRecord` column.** Today the agent
> session is just a column `sessionId` on `JobRecord` (minted/cleared in `work-service.ts`); there is no
> host session store. Promote session to a first-class entity: a **`session` table** keyed by
> `sessionId`, `{ workId (FK → jobs), kind ∈ {workflow, cli} }`, and a **`sessionConversation`** table
> reffed to it. CLI is just `kind=cli`; the workflow session is the same table with `kind=workflow`. This
> is the discriminator on receive — no wire subtype (the agent never learns the engine; `source` is the
> JWT caller, not a workflow/cli flag). It reuses the SYMMETRIC `/receive` comms wholesale (M7-12) —
> **no new agent route**: host → agent `POST /receive` (`ExecutionRequest` + `x-session-id`), reply
> agent → host `POST /receive` (`ExecutionResult`, already carries `sessionId`). Attachable from EITHER
> surface — web popup or agent CLI/REPL.
>
> **Refined 2026-06-21 — transcript, not history; poll only while open.** `sessionConversation` stores
> the **transcript** (what the CLI would print: user input + the agent's rendered `result.result`), NOT a
> structured event/tool history — that stays the agent's job (event-sourcing future). "Without the
> system stuff" is done at the SOURCE (the agent's `result.result` is already clean rendered text); the
> host writes it verbatim, no host-side filtering. Reply delivery is **poll-for-now** (no live stream —
> SSE removed M8-2, agent SSE unbuilt M4-1): the UI polls the conversation **only WHILE the popup is
> open** (configurable interval, default ~1s) and STOPS polling on close — cost is bounded to an open
> chat. Event-sourced / live streaming (re-add SSE/WS + M1-11b) is the follow-up that retires polling.

Schema (SQLite, alongside the existing work schema in `src/host/src/db/db-schema.ts`, M3-H done). Naming:
the current work/jobs table is **`Work`**; the two new tables are **`AgentSession`** and
**`AgentConversation`** (the `Agent*` prefix also avoids colliding with the auth `user/session.ts`):

```
AgentSession(      sessionId PK, workId FK → Work, kind TEXT {workflow|cli}, createdAt )
AgentConversation( sessionId FK → AgentSession, type TEXT {system|user}, content TEXT, ts )
```

`type` is the speaker: `user` = the user's input, `system` = the agent's rendered reply (what the CLI
prints back). The workflow session's existing `Work.sessionId` becomes a reference into `AgentSession`
rather than a second source of truth.

Sub-stories:

- [ ] **M8-6a · `AgentSession` + `AgentConversation` store** (host): create the two tables above. The
      host `/receive` (`src/host/src/comms/receiver.ts`) looks up `result.sessionId` in `AgentSession`:
      `kind=cli` → append a `system` row (`result.result` verbatim) to `AgentConversation`; otherwise
      the existing workflow route (`runId == temporalId` → `agent.result`). No wire change.
- [ ] **M8-6b · Poll endpoint:** `GET /api/works/:id/chat` → the cli session's `AgentConversation`
      rows (ordered) for the UI to refetch. `requirePermission` + cookie identity like the other works
      routes; 404 unless the work is the caller's.
- [ ] **M8-6c · Send endpoint:** `POST /api/works/:id/chat` → mint-or-resume the work's `kind=cli`
      `AgentSession` (existing `/session/create` with the work's OWN `workspaceId`, idempotent per
      work+user), append a `user` row, send host → agent `POST /receive` (`ExecutionRequest {runId,
      input}` + `x-session-id`, fresh per-turn `runId`), return 202. Reuses the workflow dispatch path
      verbatim — no new agent route. Same gating.
- [ ] **M8-6d · UI polling lifecycle:** the popup STARTS polling `GET .../chat` when it opens, STOPS on
      close. Interval configurable (default ~1s). No background polling when no chat is open.
- [ ] **M8-6e · Simple chat UI:** a chat "[ > ]" action on the works table (M8-4) opening a minimal
      popup — a transcript pane + a text box and Send button. Send posts to M8-6c; the pane renders the
      polled `AgentConversation`. No tool/system rendering — it shows what the CLI would print.
- [ ] **Lifecycle:** `Orchestrator.complete`/`finalizeStop` close ONLY the `kind=workflow`
      `AgentSession`, never the `kind=cli` one — it outlives the run; dropped by explicit close/retention.

**Done when:** from the works table a user opens a chat popup on a work item, sends a message, and
the agent answers operating on that work's workspace via a persisted `kind=cli` `AgentSession`; the
`user` turn + the agent's `system` reply land in `AgentConversation` and render in the popup (polled
while open, polling stops on close), and the session survives the workflow completing.
**Depends on:** M8-4 (works table), M3-H (jobs/sessions→SQLite), M7-12 (symmetric `/receive`, done).
Follow-up: live streaming (re-add SSE/WS + M1-11b) — retires the poll; event-sourced conversation;
migrate the workflow `Work.sessionId` to reference `AgentSession` (retire the column as truth).

---

### M8-7 · Live CLI stream — SSE receive over the existing send envelope — `~2.5d` · P2
Promote M8-6's poll-for-now chat to a **live stream**: the agent pushes its event taxonomy as it happens
instead of the UI refetching `AgentConversation`. Retires the M8-6 poll (M8-6d/M8-6b stay as the
durable transcript + reload-on-open; the stream is the live overlay).

> **Decided 2026-06-21 — trust boundary, not transport, is the design.** The browser talks ONLY to the
> host (cookie, same origin); the host ↔ agent link stays service-to-service (`agent:trigger` JWT,
> `user_context.ts` unchanged). The cookie NEVER reaches the agent — it can't be sent cross-origin and
> can't be decrypted there anyway. So the host is a **streaming reverse proxy**: it terminates the
> cookie-authed browser request, owner-gates it, and pipes an upstream agent SSE it opens with a minted
> service token. The agent stays a **pure executor that knows only its `sessionId`** (M7-6 preserved) —
> no `userId` on the agent session, no cookie path into the agent.
>
> **Send envelope unchanged; only receive becomes SSE.** Keep the symmetric `/receive` write path
> wholesale (M7-12): host → agent `POST /receive` (`ExecutionRequest` + `x-session-id`) is still how
> input enters. The change is the receiver's *behavior* — it routes the envelope into a LIVE session's
> input inbox and ACKs 202, instead of spawning a one-shot drain runtime. The result no longer returns
> via the `HttpResultSender` webhook; it surfaces on the stream. CQRS over the existing comms: the
> envelope commands, the SSE projects. `sender → receiver → live sse session`.

The one real new capability is a **runtime per SSE connection** + a **connection registry**. Previously
`ExecutionRunner.run` built a runtime per `EXECUTION_REQUESTED`, ran one turn, and drained it. Interactive
keeps the runtime alive for the connection's lifetime and injects each input into it; its event stream is
projected to chat frames on the connection: `runner → live runtime (by sessionId) → SSE connection`.

> **Built 2026-06-22 — runtime-per-connection, queue membership is the discriminator.** Resolved during
> build: the runtime is built in the SSE route (one per connection), not under a session `kind` lease, and
> torn down (`stopTurnLoop` + `shutdown drain`) on disconnect. The runner needs no `kind` switch — it asks
> `SseQueue.has(sessionId)`: a live connection ⇒ `runtime.injectInput(...)`, else the one-shot job path.
> The `/receive` receiver is therefore **unchanged**. Payload is **chat frames reusing `ChatMessage`** (
> `{role:"assistant", content}`), as named SSE events: `delta` (streamed), `message` (full, non-streaming
> models), `end` (closes a streamed message), `turn` (busy indicator), `ready`. Endpoint names landed as
> agent `GET /ssereceive/:sessionId` and host `PUT/GET /api/agent/cli/:workId` (+ `/input`). `Last-Event-ID`
> replay/ring-buffer is **deferred** (reconnect re-attaches; M8-6 `AgentConversation` is the durable record).

Sub-stories:

- [x] **M8-7a · Runtime per connection** (agent): the SSE route builds a streaming runtime
      (`RuntimeBuilder`, `streamOutput:true`), starts its turn loop, and drains it on disconnect. Shared
      `RuntimeBuilder` extracted from `ExecutionRunner.buildForJob`. *(`src/agent/src/server/comms/runtime-builder.ts`, `ssereceiver.ts`)*
- [x] **M8-7b · Connection registry** (agent, in-memory): `SseQueue` — `Map<sessionId, SseConnection>`
      ({res, runtime}); `register`/`get`/`has`/`deregister`. One connection per session (second attach
      409s). Ring buffer / `Last-Event-ID` deferred. *(`src/agent/src/server/comms/sse-queue.ts`)*
- [x] **M8-7c · SSE read route** (agent): `GET /ssereceive/:sessionId` — validates **service `agent:trigger`
      (the OBO token's actor) + live `SessionRegistry` session + the verified OBO subject (`userId`) matching
      the session's bound owner**. Projects `getEvents()` → `ChatMessage` frames; `text/event-stream`,
      `no-cache`, `flushHeaders()`, `:keep-alive` (15s).
- [x] **M8-7c3 · OBO user binding** (agent + host): the user rides the token, not a header. The session is
      bound to `userId` at create (`SessionRegistry`/`/session/create`); the host exchanges the caller's
      cookie subject token for an OBO bearer (`getAccessTokenWithActorAsync` — `sub`=user, `act`=host) on
      stream open; `userContextMiddleware` surfaces the actor as `serviceId` and the subject as `userId`
      (`IRequestUserInfo.userId`), and the route matches it. No spoofable `x-user-id` header.
- [x] **M8-7c2 · Runner discriminator** (agent): `ExecutionRunner` asks `SseQueue.has(sessionId)` — live
      ⇒ `injectInput` into the connection's runtime; else the one-shot `EXECUTION_RESULT` → webhook path,
      unchanged. *(`src/agent/src/server/comms/runner.ts`)*
- [x] **M8-7d · Receiver unchanged** (agent): `/receive` keeps publishing `EXECUTION_REQUESTED`; the
      live-session lookup moved to the runner, so no receiver change was needed.
- [x] **M8-7e · Host SSE proxy** (host): `GET /api/agent/cli/:workId` — `requirePermission` + cookie
      owner-gate, resolve the work's `kind=cli` session, open the upstream agent `GET /ssereceive/...` with
      a minted `agent:trigger` token, pipe with backpressure. `PUT /api/agent/cli/:workId` provisions the
      session idempotently (host-side reuse). The provision (`PUT`) and input (`POST .../input`) routes
      reject a terminal work with **409** (`isTerminalStatus` — chat is closed on a `complete` work,
      mirroring the disabled Chat button in the UI). *(`src/host/src/api/agent-cli.ts`, `comms/sender.ts`, `work/work-store.ts`)*
- [x] **M8-7f · Teardown contract**: browser `res.on("close")` → `AbortController.abort()` the upstream;
      agent `req.on("close")` → `stopTurnLoop` + `shutdown drain` + deregister. No leaked live sessions.
- [x] **M8-7g · Input proxy** (host): `POST /api/agent/cli/:workId/input` — owner gate → `sender.sendInput`
      (`/receive` + `x-session-id`, fresh `runId`), 202.
- [ ] **M8-7h · Client SSE consumer** (web): read the stream with native **`EventSource`** (
      `withCredentials: true` so the host cookie rides — no header injection, no axios; axios has no
      browser SSE streaming), rendering each event off `onmessage`/`addEventListener`. The connection IS
      the subscription — no poll loop, no manual re-subscribe (retires the M8-6 client poll); auto-reconnect
      with `Last-Event-ID` resumes off the M8-7b ring buffer. Input still posts via axios (M8-7g). Renders
      the shared event taxonomy — reuse, don't redefine (M8-3).

**Done when:** from an open CLI view a user types input that proxies host → agent over the unchanged
send envelope, and the agent's events stream back live over `GET /sse/:sessionId`, piped through the
host to the browser; the cookie never leaves the host, the agent never learns the user, and closing the
browser tab tears the upstream stream and lease down. The M8-6 poll is removed; `AgentConversation`
remains the durable transcript reloaded on open.
**Depends on:** M8-6 (`kind=cli` `AgentSession` + chat surface), M7-12 (symmetric `/receive`, done),
M7-8 (host cookie identity, done). Follow-up: event-sourced `AgentConversation` written from the same
stream the SSE projects (one source for live + durable).

---

## M9 — Consolidation follow-ups (2026-07-02 repo scan)

Still-open residue from the 2026-07-02 hardening sweep; the completed half is
the "Hardening & consolidation sweep" section in
[BACKLOG.DONE.md](BACKLOG.DONE.md).

### M9-1 · One `ExecutionRequest`/`ExecutionResult` wire contract — `~0.5d` · P2
The host↔agent envelope is defined twice —
[contract.ts](src/host/src/comms/contract.ts) and
[contract.ts](src/agent/src/server/comms/contract.ts) — and kept in sync by
hand; a field added on one side compiles clean while the wire silently drops it.
- [ ] Lift the shared wire shapes (`ExecutionRequest`, `ExecutionResult`) into
      `@agent-local/common` so both sides import ONE definition; the
      package-local bus-event wrappers (`ExecutionRequested`, `WorkflowJobPayload`)
      stay where they are.
- [ ] Test: a send→receive round-trip typed against the single contract.

**Done when:** neither package declares its own copy of the wire envelope and a
field change is a one-file edit.

### M9-2 · One sealed-ticket session middleware (auth ↔ host) — `~0.5d` · P2
[auth/src/session.ts](src/auth/src/session.ts) and
[host/src/user/session.ts](src/host/src/user/session.ts) are parallel
implementations of the same open-the-encrypted-cookie middleware over
`sealTicket`/`openTicket` (`@agent-local/common/jwt`).
- [ ] Extract one `sessionMiddleware(secret)` (next to the ticket helpers in
      common) and have both services consume it; per-service differences stay
      parameters, not forks.

**Done when:** the cookie-open logic exists once and both services'
login/me/logout flows still pass.

### M9-3 · codeindex TreeLineParser red suite — `~0.5d` · P1
8 pre-existing failures in the codeindex tests (e.g.
[treeLineParser.ts](src/codeindex/src/indexer/parsers/treeLineParser.ts)
expecting `kind: "method"`, receiving `undefined`). The worktree is clean and
tree-sitter parses `class A { m() {} }` correctly at the CLI, so it looks like
parser/grammar version drift — possibly related to the stashed per-workspace
`package-lock.json` files. The one unexplained red suite in the repo
(flagged 2026-07-02, deliberately not fixed mid-sweep).
- [ ] Reproduce, bisect the grammar/parser versions, fix or pin.

**Done when:** `npm test -w @agent-local/codeindex` is green.

### M9-4 · `LocalTool<Deps>` — tools are data, context is a constructor arg — `~0.5d` · P1
[LocalTool](src/mcp/src/local-mcp.ts) declares `invoke(args, cutoffscope)` with
no deps parameter, so any tool needing `RuntimeContext` must either close over
it (a `create*LocalMcp` factory) or subclass `LocalMcp`. Both workarounds are in
use, and the closure route grew a hand-rolled deps injector —
`bindToolContext`/`SyntheticMcp`/`ToolContext`/`RichToolResult` in
[synthetic-mcp/types.ts](src/agent/src/agent/synthetic-mcp/types.ts). The
sibling `agent.tools` repo already solved this with `ServerTool<Deps>` +
`McpToolServer<Deps>` (`mcp-tool-server/src/tool-server.ts`), whose own note
reads *"behavior is configured through options, not subclassing"*. Port the
shape, not the class — `McpToolServer` is a stdio host and `LocalMcp` must stay
transport-free.
- [ ] `LocalTool<Deps = void>`: add a third `deps: Deps` argument to `invoke`;
      `LocalMcp<Deps = void>` takes `deps` as its third constructor arg and
      passes it through `callTool`. Default `void` keeps every existing
      zero-dep tool source-compatible.
- [ ] Widen `descriptor` to `ToolDescriptor | (() => ToolDescriptor)`, resolved
      in `listTools()`. This is the ONLY reason `ExecutorLocalMcp` overrides
      `listTools` (live dispatch enum), so the thunk retires the subclass.
- [ ] Convert the `create*LocalMcp` factories (fs, excel, subsessions, delay) to
      module-level `LocalTool<Deps>` consts + `new LocalMcp(name, tools, deps)`.
- [ ] Delete `bindToolContext`, `SyntheticMcp`, `ToolContext`, `RichToolResult`.
- [ ] Rehome the two genuinely per-turn bindings (`DispatchTracker`,
      `TurnResultSink`) by resolving them from `ctx.registry` at call time, so
      `Deps` stays static and `TurnBindable`/`TurnBinding` can go.

**Done when:** no synthetic server subclasses `LocalMcp` and no tool closes over
its context; `grep "extends LocalMcp"` returns nothing.

### M9-6 · One agent tool — collapse three spawn seams into a single call — `~1.5d` · P1
A sub-agent is spawned three different ways —
[session-manager.ts:229](src/agent/src/agent/session/session-manager.ts#L229)
(detached), [executor-server.ts:147](src/agent/src/agent/synthetic-mcp/executor-server.ts#L147)
(blocking, mutex), [role-dispatch-server.ts:51](src/agent/src/agent/synthetic-mcp/role-dispatch-server.ts#L51)
(blocking, gated) — each hand-copying an 8-field `AgentRuntimeDeps` literal off
`RuntimeContext` (dropping `eventing`/`streamOutput`) and each calling
`finalize()` without `shutdown()`, so a child's scope is never cancelled on the
happy path and its external MCP clients never self-dispose (latent only because
no `mcp.json` is present today). Collapse to one rule: **an agent IS a tool —
one call builds a child runtime, runs one ask, returns a shaped answer.**
Depends on M9-4 (deps generic + descriptor thunk); the client-side shape gate it
relies on landed with M9-5 (see [BACKLOG.DONE.md](BACKLOG.DONE.md)).
- [ ] One module-level `agentTool: LocalTool<RuntimeContext>`: build via
      `buildSubRuntime({ ...ctx, orchestratorRole: role }, refs)` — `RuntimeContext`
      is already a superset of `AgentRuntimeDeps`, so the spread replaces all
      three literals — then `dispatchAsync(ask)`, return
      `ToolExecutionResult.usage` from `metricsTotals()`, and `shutdown({ mode:
      "drain" })` in a `finally`. The `returns` gate is M9-5's, not this body's.
- [ ] Mount one `new LocalMcp(role, [agentTool], ctx)` per dispatchable role in
      the whitelist. Recursion guard collapses to one rule — a dispatchable role
      mounts no agent tools — retiring the cap-0 coordinator in
      [build-sub-runtime.ts:59](src/agent/src/agent/runtime/build-sub-runtime.ts#L59).
- [ ] Delete `RoleDispatchLocalMcp` and `ExecutorLocalMcp` (its two decorations
      — live tool enum, dispatch tracker — become the descriptor thunk and a
      registry-resolved guard).
- [ ] Delete `SessionManager`, `subsessions-server` + its tools,
      `SubSessionCoordinator`, `ChildRuntime`, `SubRuntimeFactory`, the
      `SubSessionNotification` seam, `SessionManagerMiddleware` (both
      pipelines), `awaitSubSessions`/`awaitAllSubSessions`,
      `rewireTurnWake`'s notification arm, and `includeSubSessions`.
- [ ] Fix while collapsing: `mountExternal`'s `switch`
      ([mcp-registry.ts:183](src/agent/src/agent/runtime/middleware/mcp-registry.ts#L183))
      handles only `memomcp`, so `codemcp` — whitelisted for the executor role —
      silently mounts nothing despite the middleware comment claiming both spawn.
- [ ] Tests: a dispatched role returns a validated record; a child's usage lands
      in the parent's `MetricsRegistry`; a turn abort collapses the child; a
      dispatchable role advertises no agent tools.

**Done when:** one code path builds a child runtime, `grep buildSubRuntime`
shows a single call site, and no child is finalized without being shut down.

**Blocked on one decision:** sub-sessions today can outlive their parent turn
and report back through the inbox. This collapse makes every agent call
blocking. Confirm nothing depends on detached children before deleting
`SessionManager` — if something does, the fallback is a `detach: true`
descriptor flag on the same tool rather than the separate seam. Note that
[tool-caller.ts:14](src/agent/src/agent/runners/tool-caller.ts#L14) runs calls
sequentially, so parallel fan-out needs M1-10 to survive this change.

**Deliberately not doing:** moving sub-agents out-of-process. The registry holds
`Mcp`, and both `LocalMcp` and `McpClient` implement it, so the orchestrator
cannot tell an in-process server from a spawned one — a role can move from the
synthetic mount to `mcp.json` later with no upstream change. Staying in-memory
keeps free usage folding, the child→parent event bridge, the shared `agent.sqlite`
handle, and zero spawn cost; the process split stays a per-agent deployment
decision, not an architectural commitment.

---

## Open decisions — track, don't drift

- [ ] **D1 · Step-level durability.** Turn-boundary persistence loses an
      in-flight turn on crash. Decide after M3: if long detached sub-sessions
      become common, move conversation appends to event-sourced writes
      (store supports it; the in-place array mutation in
      `runners/orchestrator.ts` is the thing that would change). Default: defer.
- [ ] **D2 · Topology.** Keep the fixed orchestrator→executor→evaluator loop.
      Revisit only when a concrete workflow (e.g. parallel reviewers) demands
      a graph — don't build generality speculatively.
- [ ] **D3 · Encryption at rest.** Decide alongside M3-2: SQLite +
      SQLCipher, or document reliance on disk-level encryption. Driven by
      what data the deployments actually hold.
- [ ] **D4 · Anonymous mode in production.** CLI keeps anonymous fallback;
      decide whether service mode allows it at all (recommend: no —
      `AnonymousMiddleware` excluded from the service pipeline).
- [ ] **D5 · IoC: pure DI, no container.** Composition stays explicit —
      MR-5's factories are the composition root; the middleware pipeline is
      the per-session scope; MR-4's TurnContext removes run-time service
      location (`runtime.get*()` inside runners). Domain registries
      (ModelRegistry, McpClientRegistry) are runtime dispatch tables, not DI —
      they stay. No InversifyJS/tsyringe/Awilix unless a real trigger
      appears: a plugin system needing dynamic registration (then Awilix —
      no decorators, `createScope()` maps to session lifetime) or a NestJS
      transport in M4 (Nest DI for controllers only; agent core stays pure).
- [x] **D6 · Workflow/agent topology — co-host now, extract later.** *(decided
      2026-06-17)* The workflow service and agentic engine ship **co-hosted in one
      express process** for early operational simplicity; not split into separate
      services until load demands it. Independence is preserved structurally, not
      operationally: the two communicate **only through the bus** (M7-3), so
      extraction is a transport swap (in-memory `Eventing` → pub/sub broker)
      behind an unchanged `publish`/`subscribe`/`add` contract. **Not** worker
      threads — the agent loop is I/O-bound and already offloads execution to
      child-process MCP servers, so threads add marshalling/lifetime cost without
      parallelism gain; they remain reserved for genuinely CPU-bound work (the
      vectorizer/embeddings), orthogonal to this decision.

---

## Suggested order (solo, dependency-aware)

```
MR-1 → MR-2                                            (the gate — was M0-1)
M0-2 → M0-3 → M0-4 → M0-5 → M0-6 → M0-7                (hole-closing, disjoint files)
MR-3 → MR-4·0 → MR-4 → MR-5 → MR-6                     (finish the unified runtime)
M1-1 → M1-3 → M1-4 → M1-5 → M1-6                       (reliability; M1-2 closed by MR-4)
M2-1 → M2-2 → M2-3 → M2-4 → M2-5 → M2-6 → M2-7 → M2-8  (identity/policy — after MR)
M3-1 → M3-2 → M3-3 → M3-4 → M3-5                       (agent store; M3-H host store done)
M4-1 → M4-2 → M4-3 → M4-4 → M4-5                       (service)
M7-2 → M7-3                                            (engine × agent mesh — Temporal; after M4-1/M4-2)
M8-1 → M8-2 → M8-3                                     (react console + api; after M7-1/M7-3)
```

MR-1/MR-2 go first (they are the security fix). The M0 hygiene items touch
disjoint files and can interleave with MR-3…MR-6 freely. M2 lands after MR so
policy is written once, into `resolveAllowedTools`. M3 strictly precedes
M4-1 (leases). Total ≈ **9.5–11.5 solo weeks** of focused build time; the
milestones are each independently shippable, so the agent stays usable
throughout.
