# Production Backlog — Agent.Local

*Companion to [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md). Granular,
sequenced for one developer. Estimates are focused solo time (d = day).
Check items off here; each task lists concrete sub-steps and a "done when"
acceptance check so progress is verifiable, not vibes.*

Conventions used below:
- **Gate** = the deny-by-default tool check built in M0-1; later milestones
  extend it rather than adding new chokepoints.
- File refs are to `src/agent/src/...` unless noted.

---

## M0 — Close the holes (≈ 1.5–2 weeks)

Everything here is independent of the future user-keyed store and survives it.

### M0-1 · Dispatch-time tool gate — `~1.5d` · P0
The core fix: restrictions must hold at dispatch, not just advertisement.
> **Superseded by MR-1/MR-2** (see milestone MR below and
> [UNIFIED_RUNTIME_PLAN.md](UNIFIED_RUNTIME_PLAN.md)): the gate is built as
> the first layer of the runtime ToolPort instead of patching
> `ScopedToolClient`, so it isn't redone during the refactor. The acceptance
> test below still applies verbatim — check this item off when MR-2 lands.
- [ ] Add an `allowedTools: ReadonlySet<string>` to `ScopedToolClient`
      (or a new `GatedToolClient` decorator implementing `ToolInvoker` that
      wraps it — decorator keeps path-clamping and policy separable).
- [ ] Deny by default: unknown or unlisted tool → return
      `{ isError: true, content: "[policy-error] tool <name> is not permitted for this role" }`
      so the loop re-plans instead of crashing.
- [ ] Orchestrator (`runners/orchestrator.ts` ~L149): build the set from
      `modelFilteredTools` (which is already role+whitelist filtered).
- [ ] Executor (`runners/executor.ts` ~L85): build the set from its own
      filtered `availableTools` (it has the up-front name check; keep both —
      the gate is the backstop).
- [ ] Tests (`tests/`): orchestrator-emitted `fsmcp__write_file` is denied;
      executor calling a whitelisted tool passes; tool absent from the
      per-model `mcp` list is denied even though it exists in the registry;
      `dispatch_executor` still routes to the executor registry untouched.

**Done when:** a test proves a write tool named directly by the orchestrator
model returns `[policy-error]` and no fs mutation occurred.

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
- [x] Anthropic (`providers/anthropic-provider.ts`): moving breakpoint on the
      LAST content block of the messages array each call — done 2026-06-10
      (`applyMessageBreakpoints`, tests in `tests/anthropic-cache.test.ts`).
- [x] Third breakpoint ~15 blocks before the last for the 20-block lookback —
      done 2026-06-10, same change (budget: system 1 + messages 2 = 3 of 4).
- [x] Gemini (`providers/gemini-provider.ts`): track `expireTime` from
      `caches.create` and recreate when near expiry — done 2026-06-10
      (`cacheExpiryMs` helper + 30s margin + tests in
      `tests/gemini-cache.test.ts`). Still open: verify the explicit cache
      isn't below flash-lite's minimum-token threshold in practice (if so,
      rely on Gemini 2.5 implicit prefix caching and delete the explicit path).
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

### M1-11 · Stream assistant deltas to the UI — `~1d` · P2
The Anthropic provider streams internally only to dodge the SDK HTTP timeout and
returns `finalMessage()` (`providers/anthropic-provider.ts` ~L113), so a long
generation looks hung to the user.
- [ ] Surface token deltas through a runner event (`MESSAGE_DELTA`) the CLI/SSE
      layer can render incrementally; keep the collected final message unchanged
      for transcript/append.
- [ ] Gate delta emission on a `streamOutput` feature flag (M6-1) resolved by
      mode: interactive `chat` streams deltas; `standalone`/`api` default to
      collect-only (SSE callers opt in). Mode comes from the runtime, the flag
      value from the registry — no ad-hoc `if (isCli)` checks in the provider.

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
- [ ] Effective allowed set = role-appropriate tools ∩ per-model `mcp`
      whitelist ∩ user-policy servers/tools. Compute in ONE function
      (`resolveAllowedTools(modelRole, userPolicy, registry)`) used by both
      advertisement and the M0-1 gate — one artifact, two consumers, can't
      drift.
- [ ] `canDispatchExecutor: false` → `dispatch_executor` neither advertised
      nor dispatchable; the executor sub-agent is unreachable.
- [ ] Tests proving *denial* per layer: read-only user role blocks a write
      tool even when the model whitelist allows it, and vice versa.

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

---

## MR — Unified runtime refactor (≈ 9 focused days)

Full design and rationale in
[UNIFIED_RUNTIME_PLAN.md](UNIFIED_RUNTIME_PLAN.md). One-line versions here
for tracking; the plan doc has per-step file lists and acceptance criteria.
Absorbs M0-1 (gate) and M1-2 (token accounting); M2-4 (policy) plugs into
`resolveAllowedTools` afterward.

- [ ] **MR-1** · `resolveAllowedTools` + ToolPort skeleton (GATE → SCOPE →
      TRANSPORT); replace `READ_ONLY_TAILS` heuristic with explicit
      per-server config; M0-1 acceptance tests written here — `~1.5d`
- [ ] **MR-2** · Runtime owns the port; orchestrator/executor stop building
      their own `ScopedToolClient` + filters; kill the dual descriptor
      assembly in `OrchestratorMiddleware` — `~1d`
- [ ] **MR-3** · `SyntheticToolSet` for dispatch_executor/subsessions/excel;
      delete `refreshTurnServers` + role methods from `McpClientRegistry`
      (registry becomes a neutral transport) — `~2d`
- [ ] **MR-4** · `AgentRuntime.beginTurn()` → `TurnContext`; decompose
      `Orchestrator.run` (loop / CompletionGate / normalization →
      tool-adapter); usage accounting moves to TurnContext (closes M1-2) — `~2.5d`
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
resilience. Build them on MR-4's `step()` + `CompletionGate` seam — they are far
cleaner on a stepper+gate than bolted onto today's flat `for` in
`runners/orchestrator.ts`, so MR-4 is a hard prerequisite (consider pulling it
forward). The terminal signal below *is* a gate input; the plan state *is* what
the gate reads.

### M5-1 · Explicit completion signal — `~1.5d` · P1
Completion is currently *inferred from the absence of tool calls*
(`runners/orchestrator.ts` ~L283): a tool-free assistant turn IS the result. But
"no tool call" ≠ "done" — a model that narrates ("Let me now verify…") without
emitting a call is read as a final answer, indistinguishable from a dropped call.
- [ ] Make completion *declared*: a synthetic `done`/`finish` tool the model
      calls to end the turn (lean choice — provider-agnostic, works for the
      prompted-JSON path too), or key off the provider stop reason. Pick one.
- [ ] A tool-free turn that does NOT declare done becomes continue+nudge
      ("you didn't act — call a tool or declare done"), not a silent exit.
- [ ] CompletionGate (MR-4) consumes the signal: executor gate = done-declared;
      orchestrator gate = done-declared AND evaluator-satisfied. The
      `this.role === "executor"` branches collapse onto the gate.
- [ ] Tests: a narrating-without-acting model keeps going; an explicit done
      ends the turn; both role gates honor the signal.

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

---

## Suggested order (solo, dependency-aware)

```
MR-1 → MR-2                                            (the gate — was M0-1)
M0-2 → M0-3 → M0-4 → M0-5 → M0-6 → M0-7                (hole-closing, disjoint files)
MR-3 → MR-4 → MR-5 → MR-6                              (finish the unified runtime)
M1-1 → M1-3 → M1-4 → M1-5 → M1-6                       (reliability; M1-2 closed by MR-4)
M2-1 → M2-2 → M2-3 → M2-4 → M2-5 → M2-6                (identity/policy — after MR)
M3-1 → M3-2 → M3-3 → M3-4 → M3-5                       (store)
M4-1 → M4-2 → M4-3 → M4-4 → M4-5                       (service)
```

MR-1/MR-2 go first (they are the security fix). The M0 hygiene items touch
disjoint files and can interleave with MR-3…MR-6 freely. M2 lands after MR so
policy is written once, into `resolveAllowedTools`. M3 strictly precedes
M4-1 (leases). Total ≈ **9.5–11.5 solo weeks** of focused build time; the
milestones are each independently shippable, so the agent stays usable
throughout.
