# Production Readiness Report — Agent.Local

*Assessment date: 2026-06-10. Scope: `src/agent` (runtime, CLI, registries, synthetic MCP) plus its integration points with the sibling workspaces (`fsmcp`, `codemcp`, …). Verified against the working tree: `tsc --noEmit` clean, 23/23 test suites, 103/103 tests passing.*

> **Status update (same day):** the actionable backlog now lives in
> [BACKLOG.md](BACKLOG.md) — granular, checkbox-tracked, sequenced for a solo
> developer. The roadmap in §5 below is kept as the original assessment record;
> work from the backlog. Decisions taken since the first draft:
>
> 1. **Disk persistence is throwaway.** Sessions/workspaces/contexts will move
>    to a store keyed by user id with strict controls. This *supersedes* the
>    findings in §3.4 (store scalability/locking), §3.8 (session data in git —
>    still gitignore it meanwhile), and §3.9 (plaintext at rest) — don't invest
>    in fixing the file store beyond hygiene. Design rule agreed: the user id
>    is part of the lookup key (`load(userSub, sessionId)`), never a post-load
>    filter. See backlog M3.
> 2. **Provider-key handling agreed:** keys are read once at bootstrap and
>    baked into provider SDK clients, then scrubbed from `process.env`; spawned
>    MCP servers get an allowlisted env (deny-by-default), with per-server
>    `env` blocks in `mcp.json` as the explicit pass-through. See backlog M0-2.
>    In-process MCP servers are first-party code in the same process — env
>    hygiene doesn't apply to them; the spawned-server path is the exposure.
> 3. **Policy-as-artifact committed:** one declarative `policies.json`
>    resolved per principal, evaluated at a single dispatch-time gate that
>    also serves the model-role and per-model whitelist checks. See backlog
>    M2-3/M2-4.
> 4. **Architecture verdict** (vs. public/enterprise solutions): direction is
>    strongly aligned with the industry (MCP-native, stateless runners,
>    session-lifted state, privilege-split roles); factoring is top-decile for
>    a draft (~8/10). The gap vs. enterprise platforms is the control plane —
>    durable execution, policy engine, tenancy, telemetry — which is accretion
>    on the existing seams, not surgery. Two open architectural decisions are
>    tracked in the backlog (D1 step-level durability, D2 fixed topology).

---

## 1. Executive summary

The draft is architecturally further along than most prototypes: it has a clean
middleware-pipeline runtime, persistent resumable sessions, sub-sessions with
caps/dedupe/backoff, three providers behind one interface, a role→model
registry, and a deliberate read/write split (orchestrator reads,
`dispatch_executor` is the only mutation path). The code is well-commented and
the unit-test base is real.

What separates it from production is concentrated in four areas:

1. **Security enforcement is mostly advisory.** The role and per-model MCP
   restrictions filter which tools are *advertised* to the model, but the
   dispatch path will execute any registered tool the model names. Identity is
   an explicitly mocked JWT decode with no signature verification, and
   `Principal.scopes`/`roles` are never checked anywhere.
2. **It is a single-user CLI process.** "Standalone" service mode needs an API
   transport, cross-process session locking, and a session store that scales
   past a directory of JSON files.
3. **No operational layer.** Console-only logging, no metrics/tracing, no
   retries or rate-limit handling on provider calls, no cost budgets, no CI.
4. **Config/packaging is machine-bound.** Absolute paths in `mcp.json`, a stale
   README (`cp .env.example .env` — the file doesn't exist), session data
   tracked in git, no Dockerfile for the agent itself.

Rough total to a hardened single-tenant production service: **~10–14
engineer-weeks**. Multi-user RBAC on top of that: **+4–6 weeks**. A phased
roadmap is in §5.

---

## 2. What the draft already has (verified)

| Capability | Where | State |
|---|---|---|
| Middleware-pipeline runtime; every subsystem built by a pipeline step, missing steps reported all at once | `runtime/agent-runtime.ts` | Solid |
| Persistent, resumable sessions; atomic temp-file+rename writes; corrupt files skipped in listings | `session/session-store.ts` | Solid for single process |
| Sub-sessions: one-level-deep, per-parent cap, intent dedupe, poll backoff, completion notifications | `session/session-manager.ts` | Solid in-memory; not restart-safe |
| Read/write segregation: orchestrator advertised read-only tools + `dispatch_executor`; executor is sole mutator with deterministic post-verification | `runners/orchestrator.ts`, `runners/executor.ts` | Concept solid; enforcement gap (§3.1) |
| Per-workspace path clamp, deterministic, model-cooperation-free, idempotent, glob-aware | `scoped-tool-client.ts` | Good; fsmcp-only (§3.5) |
| Multi-provider (Ollama, Anthropic, Gemini) behind one `LLMProvider` interface; prompted-JSON fallback for non-tool models | `providers/` | Solid |
| Role→model mapping with hot-swap, per-model MCP server whitelist | `registries/model-registry.ts` | Advertisement-only (§3.1) |
| Identity scaffolding: OIDC-aligned `Principal`, tri-state auth, anonymous fallback, sessions stamped with user | `identity/`, `middleware/identity.ts` | Mock (§3.2) |
| Evaluator completion gate + mid-flight progress checks; fail-open on judge error | `runners/evaluator.ts`, orchestrator | Works; fail-open is a policy choice to document |
| Conversation summarization with provider-safe tail boundaries; manual `/compact` | `runners/summarizer.ts` | Solid |
| Token usage accounting | `session/session.ts` counters | Orchestrator calls only; executor/evaluator/summarizer not counted |
| Input inbox for steering a live run | `runners/input-inbox.ts` | Solid |
| Context snapshots, content-addressed per role | `middleware/context.ts` | Good audit primitive |
| Unit tests: middleware, registries, clamp, pairing | `tests/` | 103 passing, <1s (fully mocked) |

---

## 3. Gap analysis

### 3.1 P0 — Tool authorization is advertisement-only

The single most important finding. Role filtering
(`listToolsForOrchestrator`) and the per-model `mcp` whitelist
(`filterMcpByServerWhitelist`) only shape the tool list **sent to** the model.
The dispatch path does not re-check:

- `orchestrator.ts` (~line 306): any tool call that isn't `dispatch_executor`
  goes straight to `ScopedToolClient.callTool`.
- `ScopedToolClient.callTool` clamps *paths* but never checks whether the tool
  is permitted for the caller.
- `McpClientRegistry.callTool` resolves against `toolIndex`, which contains
  **every** registered tool — including `fsmcp__write_file`.

So if the orchestrator model emits `fsmcp__write_file` (hallucination,
prompt injection, or a provider quirk — the code even has a "recover tool
calls from prose" fallback), it executes. The read-only guarantee currently
depends on the model not asking.

**Fix:** make `ScopedToolClient` (or a wrapper) carry an explicit allowed-tool
set per role/session and reject by default at dispatch. This is also the
natural seam for the user-role policy in §3.3. ~2–4 days including tests.

Related: the read/write classification itself (`READ_ONLY_TAILS` in
`mcp-registry.ts`) is a suffix-name heuristic. Any external MCP server that
names a mutating tool `read_file` is classified read-only. For production,
classification must be **explicit per-server allowlists, deny-by-default**
(optionally seeded from MCP `readOnlyHint`/`destructiveHint` annotations, but
never trusting them from third-party servers).

### 3.2 P0 — Identity is a mock

`IdentityMiddleware` base64-decodes the JWT payload with **no signature
verification** (documented as a mock in the file). Production needs:

- JWKS fetch + signature/issuer/audience/expiry validation (e.g. `jose`).
- A decision on the credential source: `AGENT_API_TOKEN` env var is fine for
  CLI; the service mode (§3.4) needs per-request bearer tokens.
- Session-resume binding: sessions are stamped with `user`, but nothing today
  stops principal A from resuming principal B's session by id. Enforce
  `session.user.sub === principal.sub` (or scope-based override) on resume.

~1 week including tests against a real IdP (or a test JWKS).

### 3.3 P0 (for multi-user) — Authorization layer does not exist yet

`Principal.scopes` and `claims.roles` are captured and persisted but **never
read** by any enforcement point. The "user-specific roles, readonly-mcp vs
write-mcp per role" goal needs:

1. A policy model: `user role → { allowed MCP servers, allowed tools, allowed
   model roles, write permission yes/no }`, declared in config (a
   `policies.json` sibling of `models.json` fits the existing pattern).
2. Enforcement at the dispatch seam from §3.1 — the same deterministic check
   covers both "model role" and "user role" restrictions.
3. Executor gating: a read-only user must not be able to reach
   `dispatch_executor` at all (don't advertise it *and* reject it at dispatch).
4. Tests that prove denial, not just allowance.

Design + implementation ~2 weeks once §3.1/§3.2 are in.

### 3.4 P0 — Service mode and concurrency

Today the system is one process, one user, stdio. To run standalone:

- **Transport:** an HTTP/WebSocket (or SSE) API exposing
  create/resume/dispatch/inject/status/compact. The runtime API surface
  (`dispatchAsync`, `injectInput`, `onSubSessionEvent`) maps onto this almost
  1:1 — good news, the seams already exist.
- **Cross-process session locking:** the `status === "running"` guard is
  in-memory. Two processes (or a CLI and the service) resuming the same
  session id will both load, run, and last-write-wins clobber each other's
  transcripts. Needs file locks at minimum; a real store (below) preferably.
- **Session store:** `summaries()` loads and parses *every* session file on
  startup; there is no pagination, indexing, or locking. Fine for dozens of
  sessions, not thousands. SQLite (one file, zero ops) is the natural step;
  keep `SessionStore` as the interface and swap the implementation.
- **Sub-session durability:** the active-children map and notification
  subscriptions are in-memory. A restart orphans running children silently.
  Persist child status into the session record and reconcile on boot.

~3–4 weeks for a minimal hardened service.

### 3.5 P1 — Sandbox hardening

- **Symlink escape:** `fs-tools/workspace.ts` `resolveSafe` uses
  `path.resolve` string-prefix checking only. A symlink inside the workspace
  pointing outside resolves "inside" by string but reads/writes outside on
  disk. Use `fs.realpath` on the nearest existing ancestor before the prefix
  check. (The `ScopedToolClient` clamp has the same property — it normalizes
  strings, the in-process fs layer is what touches disk.)
- **External MCP servers are on the honor system:** `spawnServer` sets
  `AGENT_WORKSPACE` but nothing verifies a third-party server respects it.
  Treat external servers as untrusted: per-server tool allowlists (§3.1) and,
  for hosted deployments, OS-level sandboxing of spawned processes.
- **Environment leakage:** `spawnServer` (`mcp-registry.ts` ~line 206) copies
  the **entire parent `process.env`** — including `ANTHROPIC_API_KEY`,
  `GEMINI_API_KEY` — into every spawned MCP server. Pass a minimal allowlisted
  env instead. Small fix, real exposure. (~1 day)

### 3.6 P1 — Reliability of the model loop

- **No retries/backoff:** all three providers call their SDKs once; a 429 or
  transient 5xx aborts the whole turn (`session.status = "error"`). Add
  bounded exponential-backoff retries on retryable errors at the provider
  layer, and rate-limit awareness for Anthropic/Gemini.
- **MCP client lifecycle:** if a stdio server crashes, `callTool` returns
  "no longer connected" forever; there is no health check or reconnect.
- **Graceful shutdown:** SIGINT/SIGTERM call `shutdown()` (MCP teardown) but
  don't abort an in-flight turn via the existing `AbortSignal` plumbing or
  flush the session first. Wire signals → abort → finalize → exit.
- **Fail-open evaluator:** reasonable UX choice (never trap the user on a
  flaky judge), but in service mode it means a broken judge silently accepts
  everything. Emit a metric/alert when it fails open.

~1–2 weeks.

### 3.7 P1 — Observability and cost control

- Logging is `ConsoleLogger` with a `DEBUG` env switch. Production needs
  structured JSON logs (pino is the obvious fit) with `sessionId` /
  `subSessionId` / turn correlation on every line — the event system
  (`runner-events.ts`) already carries most of what a log/trace layer needs;
  attach a sink to it.
- No metrics: turn latency, iterations per turn, dispatch counts, evaluator
  verdict distribution, token usage and **cost per provider** are all
  computable today but exported nowhere. OpenTelemetry metrics + traces fit
  cleanly at the orchestrator/provider seams.
- Token accounting omits executor, evaluator, and summarizer calls (noted in
  `session.ts`) — i.e. the *majority of calls* in a busy turn. Fold them in,
  then add per-session and per-user **budget ceilings** that stop the loop
  deterministically (the `DispatchTracker` pattern generalizes).
- The context-snapshot mechanism is a great audit primitive; extend it with a
  persisted **mutation audit log** (who/which session/which tool/what args/
  when) — currently mutations are only visible in transient events and the
  transcript.

~1–2 weeks.

### 3.8 P1 — Configuration, packaging, supply chain

- `mcp.json` hardcodes `/Applications/www/Agent.Local/...` — breaks on any
  other machine (and is case-mismatched with the actual path). Support
  relative-to-config paths and env interpolation.
- README is stale: claims "Ollama only, no cloud calls" (Anthropic/Gemini are
  wired in), describes the old planner/coder flow, and tells users to
  `cp .env.example .env` — **no `.env.example` exists**. Docs are part of
  production.
- Git hygiene: `src/agent/sessions/*.json` and `src/agent/contexts/*.json`
  are tracked and currently show as modified — conversation data (potentially
  sensitive) is being committed. Add to `.gitignore`, purge history if needed.
- No CI, no lint/format config. Minimum: GitHub Actions running
  typecheck + tests + `npm audit` on PR; eslint + prettier.
- Dependency audit: `xlsx` (SheetJS via npm) has a history of unpatched
  advisories on the npm channel — verify the version or switch to the vendor
  CDN build/`exceljs`. Pin Node ≥20 in engines (done) and in CI.
- No Dockerfile for the agent (codemcp has one) — needed for service mode.

~1 week.

### 3.9 P2 — Data protection and prompt-injection posture

- Sessions and context snapshots are plaintext JSON on disk with no retention
  policy. For production: encryption at rest (or rely on disk-level encryption
  and say so), a TTL/cleanup job, and a redaction pass before persisting if
  transcripts may contain secrets.
- Prompt injection: `agentcontext.md` is injected as "standing direction from
  the user", and tool/MCP outputs flow back to the model unsanitized. With
  workspace-write tools in the loop, a malicious file in the workspace can
  steer the executor. Mitigations: the §3.1 deterministic tool gate is the
  main one; additionally mark tool-result provenance in prompts and keep the
  human-approval option for mutations as a configurable mode.

### 3.10 P2 — Testing depth

Current tests are excellent for wiring (middleware, registries, clamp) but
everything runs mocked in <1s. Missing:

- **Integration tests** against a real Ollama (or recorded provider fixtures)
  exercising a full turn including dispatch_executor.
- **Security tests** as first-class: dispatch-time denial (§3.1), symlink
  escape (§3.5), session-resume identity binding (§3.2). Write these as
  red/green proof of the fixes.
- **Behavioral evals:** a small task suite (n tasks × pass/fail) run nightly
  to catch quality regressions when models/prompts change — the headless mode
  with exit codes (`EXIT_SATISFIED`/`EXIT_CAPPED`) is already the right
  harness for this.
- **Load test** of the service mode (concurrent sessions, store contention).

---

## 4. Quick wins (each ≤1 day, do first)

1. Deny-by-default tool check at dispatch in `ScopedToolClient` (the core of §3.1).
2. Stop forwarding full `process.env` to spawned MCP servers (§3.5).
3. `.gitignore` sessions/ and contexts/; add the missing `.env.example`.
4. Fix the absolute path in `mcp.json`.
5. CI workflow: typecheck + jest + npm audit.
6. `fs.realpath` in `resolveSafe` (symlink escape).
7. Wire SIGINT → AbortSignal → finalize.

---

## 5. Phased roadmap

| Phase | Goal | Contents | Estimate |
|---|---|---|---|
| **0 — Harden the core** | Trustworthy single-user agent | Quick wins above; dispatch-time tool authorization; explicit per-server tool allowlists; provider retries/backoff; complete token accounting + budget caps; security test suite | 2–3 weeks |
| **1 — Real identity** | Verified principals | JWKS signature verification; session-resume ownership binding; audit log of mutations keyed by principal | 1–2 weeks |
| **2 — Service mode** | Standalone, stop/resume from anywhere | HTTP/WS API over the existing runtime seams; SQLite-backed `SessionStore` with locking; durable sub-session state; Dockerfile; structured logs + metrics + alerts | 3–4 weeks |
| **3 — Multi-user RBAC** | "User role → readonly-mcp / write-mcp" | Policy config + enforcement at the Phase-0 dispatch gate; per-user budgets/quotas; workspace-per-tenant isolation review | 2–3 weeks |
| **4 — Operate** | Keep it healthy | Nightly behavioral evals via headless mode; load tests; retention/cleanup jobs; runbooks; dependency update cadence | 2 weeks + ongoing |

Phases 0–2 ≈ **10–14 engineer-weeks** to a production single-tenant service;
Phase 3 adds **4–6 weeks** for the multi-user security model. Estimates assume
one engineer familiar with the codebase and no major architectural rework —
none appears needed; the existing seams (middleware pipeline, `ToolInvoker`,
`SessionStore`, runner events) are the right ones, which is the strongest
thing this draft has going for it.
