# Production Backlog — Agent.Local
# AI MANAGED NO MANUAL CHANGE
# AI PLS FOLLOW EXISTING FORMAT

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

- [ ] **`src/vectorizer`** (leaf, `~1d`) — `EmbedAdapter { modelId, dim,
      embedBatch, embedQuery }` + `createEmbedAdapter(provider, dim)` over
      local/voyage/openai. Deletes the hand-mirrored `LocalQueryEmbedAdapter`
      in `codemcp/src/embed.ts` — one impl, no more "change one, change the
      other." Pure compute, no DB.
- [ ] **`src/vectorstore`** (leaf, `~1.5d`) — one copy of
      `DbConnection`/`DbConnectionFactory` (kills the byte-identical dupe across
      `codeindex/db/types.ts` and `codemcp/db/types.ts`), pg + file backends,
      generic `VectorRecord { id, namespace, content, embedding, metadata }` and
      `VectorStore { upsert, searchByEmbedding(ns, emb, k, filter), delete }`.
      `namespace` is opaque; filter is generic equality over `metadata`.
- [ ] **`src/codeindex` on the engine** (`~1d`) — walker/chunkers/commit
      unchanged; `publish.ts` writes through `vectorstore`, code fields into
      `metadata`. Output stays byte-compatible (`data/commits/<sha>/…`);
      golden-file test guards it.
- [ ] **`src/codemcp` on the engine** (`~1d`) — reads via `vectorstore`, embeds
      queries via `vectorizer`. `search_code`/`find_symbol` surface + results
      unchanged; code enums become a code-only typed wrapper over the generic
      filter.
- [ ] **`src/memomcp`** (new, `~1.5d`) — `remember`/`recall` over `vectorstore`
      + `vectorizer`, partitioned by collection. tenant/category live in
      `metadata` (filtering), NOT in the path; id↔association/linking is a
      separate concern kept out of the store. Must use voyage/openai (local
      bag-of-words can't do paraphrase recall).
- [ ] **`src/mcp`** (new base/reference, `~1d`) — extract the MCP scaffolding
      that every server re-implements into one shared package so `codemcp` /
      `memomcp` (and future servers) derive from it instead of drifting. Move
      the trio out of `src/agent/src/agent/mcp/`: the **base contract**
      (`mcp.ts` — `Mcp` / `ToolInvoker` / `ToolExecutionResult`), the **actual**
      server (`mcp-client.ts` — `McpClient`, spawned stdio JSON-RPC), and the
      **virtual** server (`local-mcp.ts` — `LocalMcp`, in-process handlers).
      Ships a minimal reference server as the copy-from example; the agent
      imports the contract from here rather than owning it.

**Sequencing:** 1, 2 & 6 in parallel (all leaves) → 3 & 4 prove no regression on
real data → 5 builds on a proven engine **and** the shared MCP base.

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
  surface in `src/common`.

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
- [ ] `TurnCounterMiddleware` lands here as the proof-of-seam consumer:
      subscribes to `ctx.events` for `orchestrator-message`, accumulates
      per-round `usage` into a local tally, logs/stamps it on turn end. It does
      **not** own a registry yet (MR-4b). Out of scope: MetricsRegistry,
      removing the inline `session.counters` fold, delegated usage, persistence.

**Done when:** a no-op middleware registered in the group runs around a turn
with the result unchanged; `TurnCounterMiddleware`'s per-round tally equals the
sum the orchestrator folded into `session.counters` that turn; zero diff to
`orchestrator.ts` core loop.

#### MR-4b · MetricsRegistry — split metrics from session — `~1d` · P1
Per-turn/per-round token metrics become a container-owned service, not session
state. Moves ownership off `session.counters` (decision: move now — its blast
radius is contained to this story). Depends on MR-4a.
- [ ] `runtime/metrics/metrics-registry.ts`: `MetricsRegistry`
      (`recordRound(usage)`, `rounds()`, `totals()`), registered via
      `MetricsRegistryMiddleware` (init pipeline) into the Container.
- [ ] Upgrade `TurnCounterMiddleware` from local tally → writes into
      `MetricsRegistry` (it becomes the owner/writer).
- [ ] Remove inline `foldCounters` / `foldDelegatedUsage` from
      `runners/orchestrator.ts` (~L211, ~L298); the loop stops touching token
      accounting.
- [ ] Resolve delegated-usage capture: tap `dispatch-feedback` (verify it
      carries `usage`; add it to the event if not) so subtree cost survives the
      move (mirrors `foldDelegatedUsage`).
- [ ] Persistence migration: what was in `session.counters.*Tokens*` now sources
      from the registry — update the snapshot shape and any CLI `/context` / cost
      readout that reads counters; add a migration shim if a stored field moves.

**Done when:** the loop no longer mutates `session.counters`; metrics read from
`MetricsRegistry`; token totals (direct + delegated) match pre-change figures on
a fixture turn; cost/usage readouts still render.

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

**Done when:** an ambiguous, context-free request no longer produces an
evaluator-minted AWAITING-INPUT clarification, and the evaluator's verdict is
derived only from the last intent + this turn's transcript.

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
M2-1 → M2-2 → M2-3 → M2-4 → M2-5 → M2-6 → M2-7 → M2-8  (identity/policy — after MR)
M3-1 → M3-2 → M3-3 → M3-4 → M3-5                       (store)
M4-1 → M4-2 → M4-3 → M4-4 → M4-5                       (service)
```

MR-1/MR-2 go first (they are the security fix). The M0 hygiene items touch
disjoint files and can interleave with MR-3…MR-6 freely. M2 lands after MR so
policy is written once, into `resolveAllowedTools`. M3 strictly precedes
M4-1 (leases). Total ≈ **9.5–11.5 solo weeks** of focused build time; the
milestones are each independently shippable, so the agent stays usable
throughout.
