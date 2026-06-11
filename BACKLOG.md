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
- [ ] Update the code comment in `session/session.ts` that documents the gap.

### M1-3 · Budget ceilings — `~1d` · P1
- [ ] `orchestration` config: `maxTokensPerTurn`, `maxTokensPerSession`
      (0 = unlimited). Check after each accumulate; on breach, end the turn
      deterministically with a new outcome `"budget-capped"` (mirror the
      existing `"capped"` path in `runners/orchestrator.ts` ~L343).
- [ ] Headless exit code for budget-capped (extend `cli/index.ts` codes).
- [ ] Test: tiny budget + fake provider → loop stops with the right outcome.

### M1-4 · Evaluator fail-open visibility — `~0.5d` · P2
- [ ] New event type `EVALUATION_FAILED_OPEN` (today it's a generic WARNING
      in `runners/orchestrator.ts` ~L443) + a session counter, so a dead
      judge is observable instead of silent leniency.

### M1-5 · MCP client resilience — `~1d` · P2
- [ ] Detect transport death in `McpClient` (closed/error event from the
      SDK client); mark disconnected.
- [ ] One lazy reconnect attempt on next `callTool` for stdio servers
      (respawn via stored config); on failure return the existing
      "no longer connected" error.
- [ ] Test with a server process that exits mid-session.

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

### M2-5 · Mutation audit log — `~1d` · P1
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

---

## Suggested order (solo, dependency-aware)

```
M0-1 → M0-2 → M0-3 → M0-4 → M0-5 → M0-6 → M0-7        (hole-closing)
M1-1 → M1-2 → M1-3 → M1-4 → M1-5                       (reliability)
M2-1 → M2-2 → M2-3 → M2-4 → M2-5                       (identity/policy)
M3-1 → M3-2 → M3-3 → M3-4 → M3-5                       (store)
M4-1 → M4-2 → M4-3 → M4-4 → M4-5                       (service)
```

M1 can interleave with M2 freely (no shared files beyond the gate).
M3 strictly precedes M4-1 (leases). Total ≈ **8.5–10.5 solo weeks** of
focused build time; the milestones are each independently shippable, so the
agent stays usable throughout.
