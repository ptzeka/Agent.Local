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

### M1-1 · Provider retry/backoff decorator — `~1.5d` · P0
- [ ] `RetryingProvider implements LLMProvider` wrapping any provider:
      retry on 429/5xx/network errors, jittered exponential backoff,
      honor `retry-after` when present, hard cap (e.g. 4 attempts),
      respect `AbortSignal` between attempts.
- [ ] Wrap at construction in `providers/index.ts` so all three providers
      and every role get it for free.
- [ ] Non-retryable errors (400 schema, auth) pass through immediately.
- [ ] Tests with a fake provider: succeeds-after-2, gives-up-after-cap,
      abort-during-backoff.

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

### M1-3 · Budget ceilings — `~1d` · P1
- [ ] `orchestration` config: `maxTokensPerTurn`, `maxTokensPerSession`
      (0 = unlimited). Check after each accumulate; on breach, end the turn
      deterministically with a new outcome `"budget-capped"` (mirror the
      existing `"capped"` path in `runners/orchestrator.ts` ~L343).
- [ ] Headless exit code for budget-capped (extend `cli/index.ts` codes).
- [ ] Test: tiny budget + fake provider → loop stops with the right outcome.

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
- [ ] Detect transport death in `McpClient` (closed/error event from the
      SDK client); mark disconnected.
- [ ] One lazy reconnect attempt on next `callTool` for stdio servers
      (respawn via stored config); on failure return the existing
      "no longer connected" error.
- [ ] Test with a server process that exits mid-session.

### M1-7 · Tool-call execution isolation in the loop — `~0.5d` · P1
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

### M1-13 · Required-field presence check at the client — `~0.5d` · P1
Scope deliberately minimal: the client checks ONLY that a tool's declared
`required` keys are present; the servers throw the rest. Value-level validation
already lives server-side and stays there — fsmcp Zod-parses every arg
(`fsmcp/src/server.ts` L46 `schema.parse`, errors caught into `isError` at L165),
so types/enums/bounds/required are all enforced for free; the synthetic LocalMcp
tools (dispatch/subsessions/excel) hand-read `args.x ?? default` and keep their
own value guards (e.g. the non-empty `intent` check). The gap the client closes
is uniform PRESENCE: synthetic tools never parse their hand-written schema, so
`required`/`enum` there are advisory, and a missing field yields a tool-specific
string (`[dispatch-error] intent is required`) instead of one recoverable error.
Every tool already carries `inputSchema` on its `ToolDescriptor` and
`ScopedToolClient` already resolves `name → { client, toolTail }` before dispatch
(L30-39), so the `required` array is in hand at the choke point. Lands as the
**VALIDATE layer of the ToolPort (MR-1)**, not a new chokepoint.
- [x] Required-presence ONLY: read the resolved tool's `inputSchema.required`,
      verify each key exists in `args`, before `client.callTool`. No ajv, no
      type/enum/pattern engine (none of our schemas use `pattern`/regex anyway,
      and one conditional-required case — codemcp `repository`, "REQUIRED when
      auto-detection failed" — is runtime-only and must be left to the tool). A
      ~20-line key walk, not a schema library. → `missingRequired()` helper in
      `scoped-tool-client.ts`.
- [x] Corrective error on a missing key: `{ isError: true, content }` naming the
      absent field(s) (reuse the `ScopedToolClient` corrective-error pattern) so
      the loop re-plans and re-emits — never throw.
- [x] Presence ≠ non-empty: `required` only checks the key exists, so
      `intent: ""` passes here by design — empty/whitespace is a VALUE problem
      the server keeps rejecting (dispatch keeps its `if (!intent)` guard). Do
      NOT fold value checks into the client.
- [x] Leave server-side validation untouched: fsmcp's Zod parse and the
      synthetic value guards stay. dispatch's `if (!intent)` doubles as the
      empty-string value guard, so it stays as-is (it is the value arm).
- [x] Tests: a dispatch with `intent` absent is rejected at the client with a
      field-named error (not the old string) and never reaches the executor; a
      present-but-empty `intent` still falls through to the server's existing
      guard; a fully-valid call passes untouched. → 6 tests in
      `tests/scoped-tool-client.test.ts`.

**Done when:** a tool call missing a `required` key returns one uniform
field-named corrective error from the client and the mutation never runs, while
all value-level validation (types, enums, empty-string) stays server-side. ✅ DONE

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
- [ ] `better-sqlite3`; tables: `sessions(user_sub, session_id, status,
      payload, created_at, updated_at, PRIMARY KEY(user_sub, session_id))`,
      `contexts`, `audit`. WAL mode.
- [ ] Swap in via `StoreMiddleware` (config: `AGENT_STORE=file|sqlite`).
- [ ] Port `summaries()` to a SQL query (kills the load-every-file scan).
- [ ] Migration script: import existing `sessions/*.json` under an
      `anonymous` (or chosen) userSub.

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
Today `search_code` / `find_symbol` embed the query, rank the whole result set,
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
chunks, `find_symbol`/`get_file_context` return ALL matching chunk **bodies**, and
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
      pure vector neighbors — merge `find_symbol` into `search_code` ranking, not a separate
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

## M7 — Workflow orchestration (Camunda 8 × Agentic mesh)

A long-running business-process layer that *drives* the agent. Camunda 8 (Zeebe)
owns the BPMN process state; the agent is a worker it dispatches to. The Node
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

**Invariant — Camunda always initiates.** The only flow is
`Camunda job → agent dispatch → result → Camunda completes the job → process
advances`. The agent never starts a process; it answers jobs and reports back.
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

### M7-1 · Camunda 8 workflow engine + express bootstrap — `~3d` · P0
A new `src/workflow` workspace: an express service that hosts Zeebe job workers
and a thin control surface over a self-managed Zeebe broker.
- [x] New workspace `@agent-local/workflow` (`src/workflow`), `@camunda8/sdk`;
      signal wiring (one root `AbortController` in `main.ts`, `ctx.signal` threaded
      to `stop()`). Express bootstrap itself lives in `@agent-local/host`; workflow
      exposes a `mount(app, ctx)` it registers into. *(2026-06-17)*
- [x] Self-managed Zeebe broker via `docker-compose.yml` (`camunda/zeebe:8.7.6`,
      Operate commented optional); endpoint + auth from env, never hard-coded. *(2026-06-17)*
- [x] `ZeebeClient` wrapper: deploys `src/workflow/bpmn/*.bpmn` on connect; control
      surface `POST /workflow/process` (start) + `GET /workflow/process/:key`
      (state) on the mounted app. *(2026-06-17)*
- [x] Job worker for task type `agent-execute`: publishes `workflow.job` to the bus
      and `forward()`s to hold the job open (real dispatch deferred to the agentic
      package, not a no-op). *(2026-06-17)*
- [x] Resilience: reconnect-with-backoff, graceful `stop()` on `ctx.signal` that
      never throws, broker-down-at-boot does not crash; `GET /workflow/healthz`. *(2026-06-17)*
- [x] Sample BPMN (`agent-execute.bpmn`, start → service task → end) + 4 Jest tests
      — *against an injected fake gRPC*, broker not required. *(2026-06-17)*
- [ ] Live-broker E2E (deploy + started instance parks a job on a real Zeebe) —
      still pending; needs the docker-compose broker up.

**Done when:** ~~`npm run dev -w @agent-local/workflow` boots…~~ — superseded: the
worker, BPMN deploy, control endpoints, resilience, and tests landed 2026-06-17
(mounted into `@agent-local/host`, verified live); only the live-broker E2E remains.

### M7-2 · Packagable agentic engine — resilient background service — `~2.5d` · P0
Wrap the host-agnostic runtime + the M4-1 HTTP surface into one embeddable
engine object. **Co-hosted today** (mounted into the workflow express process),
but built standalone-ready so the later split is a deploy change, not a rewrite —
it never reaches into workflow internals, only the bus.
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
- [ ] *Remaining for "done":* a live-model turn + running broker E2E (the seam is
      verified `workflow.job → agent.job → worker → session` on a real bus; the
      model turn + `completeJob` need Ollama/a provider and a Zeebe broker).
- [ ] Enforce the invariant in code end-to-end (agent has no path to start a
      process) + an E2E test asserting on Camunda state, not logs.

**Done when:** starting the sample process instance drives one full
`Camunda job → agent execute → result → job complete → process advances` cycle
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

### M7-5 · Camunda IAM identity inheritance for the worker runtime — `~1.5d` · P1
Camunda runs each process under an IAM identity (service account / similar). The
agent worker should **inherit that identity for the process**, so the runtime
executes as the workflow's identity rather than an ambient token. Today
`buildWorkerRuntime` sets `credentials` from a static `AGENT_API_TOKEN` env — the
target is the process's IAM identity carried on the job (IAM identity vs
JWT-as-middleware).
- [ ] Carry the identity on the bus: `workflow.job` / `agent.job` include the
      instance's IAM identity (or a token/assertion to exchange), populated from the
      Camunda job/process variables or job headers.
- [ ] Worker passes it into the runtime as `credentials` (`IdentityContext`) per
      instance instead of the ambient `AGENT_API_TOKEN`; the runtime's identity
      middleware consumes it.
- [ ] Identity is **per process instance** (matches the one-session-per-instance
      lifetime, M7-3/M7-4) — every job of the instance runs as the same identity.
- [ ] Tests: a job carrying an identity builds a runtime whose `IdentityContext`
      reflects it; absent identity falls back to anonymous/dev.

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
  ├─ status:        new | running | stuck | cancelled | error | completed
  ├─ workspaceId:   guid naming the shared folder/bucket (workspaces/<workspaceId>)
  ├─ sessionId:     the agent session (metrics + conversation), linked under the unit
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
- [ ] **`+` Trigger endpoint** *(decision 2026-06-18)* — the host-initiated entry
      point, under `/workflow` (host owns `workId`): `POST /workflow/trigger`
      `{ workflowId }` → `202 { workId }`. The trigger, in order: mint `workId` →
      `jobs.add(workId)` (`new`) → **create the agent session up front**
      (`sessionId`, recorded `sessionId ↔ workId`) → start Camunda → wire the join.
      Bus-pure start: trigger `publish`es `workflow.start` `{ workId, workflowId }`;
      the workflow mount subscribes, calls `createProcessInstance`, and replies
      `workflow.started` `{ workId, camundaId }`; the host fills `camundaId → workId`
      + `update(workId, { camundaId, status:'running' })` async. (Invariant holds:
      the host starts a *process*, never dispatches the agent — Camunda still
      initiates every job.)
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

### M8-1 · React + express scaffold (sandbox conventions) — `~2d` · P1
- [x] New workspace `@agent-local/web` (`src/web`): React 19 + react-router 7 +
      **MUI**, **Webpack 5 + Babel**, three bundles (client / standalone server /
      `mount` library) via `webpack.dev.mjs` / `webpack.prod.mjs`. No Vite. *(2026-06-17)*
- [x] Streaming SSR (`renderToPipeableStream`) server (`src/web/src/server/`),
      mountable into the host via `mount(app, ctx)` (the host imports the ESM
      `dist/server/mount.js` library + co-located static assets). *(2026-06-17)*
- [x] Startup scripts: `dev` (concurrent webpack watch + nodemon), `build`,
      `start`, `clean`. *(2026-06-17)*
- [x] Minimal shell — MUI-themed layout, one react-router 7 route, hello page, a
      health badge hitting `GET /healthz`. No feature views yet (M8-3). *(2026-06-17)*
- [ ] `/api` tunnel + `webpack serve` dev-proxy parity — deferred to M8-2 (no API
      to tunnel to yet).

**Done when:** ~~…~~ — **met 2026-06-17**: web builds all bundles, the co-hosted
`@agent-local/host` SSR-renders the React shell at `/`, serves `/static/app.js`
(200), and the health badge reads the live host `/healthz`. Verified end to end.

### M8-2 · Express API (OpenAPI) + bus→browser bridge — `~2d` · P1
A thin BFF on the express host, layered over the existing endpoints, **described
by an OpenAPI/swagger spec** the frontend generates its typed client from — plus
the live event stream the UI renders.
- [ ] BFF endpoints on the express host (`src/web/src/server/`): list/start
      process instances (proxy M7-1), list/read agent sessions (proxy M4-1) —
      shape responses for the view, don't reimplement engine logic.
- [ ] Publish an OpenAPI/swagger spec for these endpoints; generate the client
      with `openapi-typescript -g typescript-fetch` into `src/web/src/api_module/`
      via an `npm run gen` script (mirrors the sandbox's `gen` flow), consumed
      through an **axios** factory + domain hooks — `api_module/` is generated,
      never hand-edited.
- [ ] Bus→browser bridge: subscribe the express handler to the `Eventing` root
      (M7-3) and stream events to the browser as **SSE**, reusing M4-1's
      runner-event serialization 1:1 (don't invent a second wire format);
      WebSocket only if a later view needs client→server push.
- [ ] Correlation passthrough: each streamed event carries its
      `processInstanceKey` / `sessionId` so the client can route it to the right
      view without a second lookup.
- [ ] OIDC auth mirroring the sandbox: `express-openid-connect` server middleware
      handles login/session, `oidc-client-ts` on the client; the token is sent as
      bearer to the `/api` tunnel → validated → `IdentityContext` on the same M4-1
      path (no anonymous console in service mode, per D4).
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

**Done when:** the console renders a `jobId | status | description | action` table
sourced from `/api/jobs`, rows update live as work units change state, and Cancel
stops a running work unit and its Camunda instance.

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
M3-1 → M3-2 → M3-3 → M3-4 → M3-5                       (store)
M4-1 → M4-2 → M4-3 → M4-4 → M4-5                       (service)
M7-1 ∥ M7-2 → M7-3                                     (camunda × agent mesh; after M4-1/M4-2)
M8-1 → M8-2 → M8-3                                     (react console + api; after M7-1/M7-3)
```

MR-1/MR-2 go first (they are the security fix). The M0 hygiene items touch
disjoint files and can interleave with MR-3…MR-6 freely. M2 lands after MR so
policy is written once, into `resolveAllowedTools`. M3 strictly precedes
M4-1 (leases). Total ≈ **9.5–11.5 solo weeks** of focused build time; the
milestones are each independently shippable, so the agent stays usable
throughout.
