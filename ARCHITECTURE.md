# Architecture — Agent.Local

*2026-06-12, commit `e742c2f`. Essence only — deep dives live in
[TURN_ROUND.md](TURN_ROUND.md), [UNIFIED_RUNTIME_PLAN.md](UNIFIED_RUNTIME_PLAN.md),
[REGISTRY_PATTERN.md](REGISTRY_PATTERN.md), [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).*

## The pitch

A workflow platform for work that cannot afford improvisation — taxes,
filings, regulated back-office — with an AI agent core that is **configured,
not coded**. Every workflow step runs an agent role defined purely in config
(model, tools, prompt), every capability is gated deterministically by who is
running the workflow — enforced at dispatch, not requested in a prompt — and
every mutation flows through one auditable gateway with an isolated,
replayable session trail. Sensitive steps can run on local models so data
never leaves the machine, while judgment-heavy steps use cloud models — per
role, per user, per workflow. The result: AI that does the work, and a
deterministic envelope that proves what it did, who allowed it, and what it
was never allowed to touch.

## The one-paragraph version

One `AgentRuntime` serves every shape — CLI chat, headless one-shot, executor
child, subsession child — assembled by a **middleware pipeline** and differing
only in which steps are stacked and which **role** it runs. A role is pure
config (`models.json`: role → model → MCP server whitelist + prompt), so new
agent kinds (executor, evaluator, a future tax bot) are config + a toolset,
not new runtime code. Tools live behind one neutral `Mcp` interface whether
in-process or external; mutation rights are separated **structurally** (the
orchestrator's whitelist simply contains no write servers — writes go through
`executor__dispatch`, which spawns a fresh child runtime). `session.user`
rides every child, giving future per-user policy one deterministic seam.

## Layering rule

```
UI / Hosts          cli/ (repl, render, headless)        — input, display
Services            runners/, runtime/, session/          — orchestration, scheduling, state
Repository/External registries/, mcp/, synthetic-mcp/, providers/, store
```

Layers call downward only; runners obtain dependencies through
`AgentRuntimeQueryable` getters, never by ad-hoc imports of lower layers.

## AgentRuntime & the middleware pipeline

[agent-runtime.ts](src/agent/src/agent/runtime/agent-runtime.ts) is the
stateful owner of ONE session. `build()` constructs **nothing** itself: each
subsystem is produced by a pipeline step writing into a shared
`RuntimeContext`; missing steps are reported all at once. Purpose of
middleware: make construction **ordered, swappable, and inspectable** — a
child runtime is the same pipeline with three steps swapped, not a second
codepath.

| Step ([middleware/](src/agent/src/agent/runtime/middleware/)) | Produces |
|---|---|
| `logger` | Logger |
| `configuration` | ConfigurationRegistry (models.json + OrchestrationConfig) |
| `providers` / `models` | ProvidersRegistry / ModelRegistry |
| `store` / `workspace-registry` | SessionStore / WorkspaceRegistry |
| `identity` → `anonymous` | Principal (JWT decode, anonymous fallback) |
| `session` | open/resume the Session |
| `conversation` | the transcript (ConversationStore-backed) |
| `mcp-registry` | McpClientRegistry with in-process LocalMcps mounted |
| `connect-mcp-servers` | stdio servers from mcp.json *(currently stubbed)* |
| `orchestrator` | the one stateless Orchestrator runner |
| `context` | hashed per-role context snapshot |
| `input-inbox` / `session-manager` | InputInbox / SessionManager (sub-sessions) |

Child variant ([build-sub-runtime.ts](src/agent/src/agent/runtime/build-sub-runtime.ts)):
`identity+anonymous` → `inherited-user` (adopt parent's user), `session` →
`child-session` (parent-linked fresh session), and the SessionManager is
capped at 0 — the one-level-deep guard.

## Registries

Deliberately **dumb lookups** ([registries/](src/agent/src/agent/registries/));
consumers compose, config is assumed consistent by contract (validation
belongs to the config producer, not the runtime).

- **ConfigurationRegistry** — reads/merges models.json; owns orchestration
  limits (iteration caps, dispatch caps, summarization thresholds).
- **ProvidersRegistry** — provider instances (Ollama / Anthropic / Gemini
  behind one `LLMProvider`; prompted-JSON fallback for non-tool models).
- **ModelRegistry** — role → model map, per-model MCP whitelist
  (`getValidMcpForModel`), role prompts. The heart of per-role privilege.
- **McpClientRegistry** — neutral transport: register / getClient /
  listTools. Knows nothing of roles or turns.
- **WorkspaceRegistry** — workspace id → root + project context
  (agentcontext.md).

## Tools: one interface, three kinds

The [`Mcp`](src/agent/src/agent/mcp/mcp.ts) contract (`listTools` /
`callTool`) makes every tool source interchangeable:

- **LocalMcp** — in-process toolsets as plain function calls (fsmcp, excel,
  subsessions, executor). Extensible with anything: a toolset + a server name
  + a whitelist entry = a new capability.
- **McpClient** — external stdio servers (codemcp via mcp.json; reconnection
  currently stubbed).
- **ExecutorLocalMcp** ([synthetic-mcp/executor-server.ts](src/agent/src/agent/synthetic-mcp/executor-server.ts))
  — the mutation gateway: `executor__dispatch` spawns a **brand-new child
  runtime per mutation** (own session/conversation/persistence, role
  "executor"), serialized by a mutex, guarded by DispatchTracker (caps +
  duplicate detection). Child token usage returns on
  `ToolExecutionResult.usage` and folds into the parent's tally.

`ScopedToolClient` is the single dispatch front per role: fronts N mounted
servers, routes `<server>__<tool>`, clamps fsmcp paths to the workspace,
emits tool events.

## Runners

Stateless logic over runtime-provided state
([runners/](src/agent/src/agent/runners/)):

- **Orchestrator** — the model loop: ask → tool calls → evaluator gate →
  repeat. One instance per runtime, any role.
- **Evaluator** — completion judge on its own configured model; fail-open by
  policy.
- **Summarizer** — threshold-gated and manual (`/compact`) transcript
  folding.
- **TurnRunner** — the session's single-writer scheduler (turns → rounds →
  iterations); makes multi-producer input (user, subsessions, future API)
  race-free by construction. See [TURN_ROUND.md](TURN_ROUND.md).
- **InputInbox** — steering *inside* a live round (drained per iteration);
  rounds sit one level above.
- **subsession** — detached children with caps, intent dedupe, settle
  notifications that auto-wake the parent's turn loop.

## State & persistence

- **Session** — run state: status, counters (incl. delegated usage), links
  (`parentSessionId`, `conversationId`), stamped `user`.
- **Conversation** — the transcript, its own store/file; reset is a soft
  delete (audit file kept), compact replaces it with a summary checkpoint.
- **SessionStore** — atomic JSON-per-session writes (interim; a real store
  keyed by user id is planned — see PRODUCTION_READINESS).
- **Context snapshots** — content-addressed per role
  (`session.contextHashes[role]`); prompts/context come ONLY from this
  snapshot.

## Security model (current + seam)

Today: structural separation (no write servers in the orchestrator's
whitelist; executor children resolve their own surface), workspace path
clamp, dispatch caps/dedupe. Identity is a **mock** (unverified JWT).
Planned: deterministic per-user checks — `policies.json` resolved per
principal, intersected with the role whitelist at the dispatch seam;
`session.user` is already inherited by every child, so one check covers every
nesting level.

## Where work continues

External MCP remount, policies.json enforcement, real JWT verification,
orchestrator decomposition (MR-4), turn-snapshot persistence, service mode.
The path to multi-process service mode is a durable, **session-sharded**
`TurnStore` behind the same runner — `sessionId` is the shard key and the
ownership lease, the queue half goes to storage while the live turn stays
in-memory, and steady state never polls (see
[TURN_ROUND.md §10](TURN_ROUND.md)). Tracked in [BACKLOG.md](BACKLOG.md) and
[PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).
