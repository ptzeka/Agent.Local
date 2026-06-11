# Unified Runtime Plan

*Design + migration plan, 2026-06-10. Goal: make `AgentRuntime` the single
glue layer — every agent interaction flows FROM the runtime, through one
context-aware tool connector; MCP clients (synthetic or external) become
neutral transports; construction is consolidated into domain factories
invoked by the runtime instead of imports called left and right.*

Companion docs: [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md),
[BACKLOG.md](BACKLOG.md) (this plan adds milestone **MR** there; backlog
items M0-1 and M2-4 are *implemented inside* this design, not separately).

---

## 1. The problems, with evidence

### 1.1 The tool path is scattered across five owners

Today a tool call can be born, filtered, clamped, intercepted, and dispatched
in five different places, each holding part of the context:

| Concern | Where it lives today |
|---|---|
| Role filtering (read-only split) | `McpClientRegistry.listToolsForOrchestrator` (name-suffix heuristic) |
| Per-model server whitelist | `ModelRegistry.filterMcpByServerWhitelist`, called inside `Orchestrator.run` AND `Executor.run` |
| Path clamp | `ScopedToolClient`, constructed ad hoc in `Orchestrator.run` ~L149 AND `Executor.run` ~L85 |
| Synthetic interception | `executorRegistry.has(...)` branch inside the orchestrator loop (~L297) |
| Per-turn synthetic servers | `createSubsessionsMcpServer` + `McpClientRegistry.refreshTurnServers` called from `Orchestrator.run` (~L202) |

Consequences: the registry is NOT neutral (it knows about turns via
`refreshTurnServers`), the orchestrator is a dispatcher (it knows which tools
are synthetic), and no single point can enforce policy — which is exactly why
the advertisement-vs-dispatch gap exists.

### 1.2 Tool assembly happens twice

`OrchestratorMiddleware` assembles descriptors and builds an
`ExecutorRegistry` at init (`runtime/middleware/orchestrator.ts` L37–52)…
then `Orchestrator.run` rebuilds the executor registry and re-filters tools
**per turn** (L140–147). Two sources of truth that can drift; one of them
also produces `new Orchestrator(undefined as any)` (L53) — the `as any` is
the architecture telling us the dependency direction is wrong.

### 1.3 `Orchestrator.run` is a runaway

One ~240-line method currently owns: summarization triggering, provider
resolution, tool filtering ×2, executor-registry build, scoped-client build,
synthetic context assembly, per-turn server refresh, injected-prompt
draining, the model loop, native/prompted tool-call normalization, synthetic
vs MCP dispatch branching, usage accounting, the completion gate, periodic
progress checks, nudge message construction, and cap handling. The loop
itself is fine; the *setup* and the *dispatch branching* don't belong to it.

### 1.4 Factory sprawl

~12 ad-hoc construction entry points imported point-to-point:
`createProvider`, `createWorkspace`, `createExcelMcpServer`,
`createSubsessionsMcpServer`, `createExcelTools`, `createSubSessionTools`,
`buildExecutorRegistry`, `getExcelToolDescriptors`,
`getSubsessionToolDescriptors`, `McpClient.createFromConnection`,
`SessionStore.create`, `buildSubRuntime` — plus `new Executor/Evaluator/
Summarizer(runtime)` sprinkled inside runners. Each caller decides
construction policy locally; nothing owns "how do I make an X".

---

## 2. Target architecture

### 2.1 One connector: `RuntimeToolPort`

A single runtime-owned object is THE tool boundary. Working name
`RuntimeToolPort` (alternatives: `RuntimeMcpClient`, `ToolGateway` — pick
one, then it's final; this doc uses ToolPort).

```ts
// runtime/tool-port.ts
export interface ToolSurface {
  /** What this role's model is shown. Computed once, identical to what dispatch allows. */
  descriptors: ToolDescriptor[];
}

export interface DispatchContext {
  role: AgentRole;                  // "orchestrator" | "executor" | ...
  session: Session;
  workspace: Workspace;
  signal?: AbortSignal;
  emit: RunnerListener;
}

export class RuntimeToolPort {
  surfaceFor(role: AgentRole): ToolSurface;
  dispatch(call: ToolCall, ctx: DispatchContext): Promise<ToolExecutionResult>;
}
```

Internally it is a fixed pipeline of `ToolInvoker` layers, composed in ONE
place:

```
dispatch(call)
  ├─ 1. GATE      allowed-set check, deny by default        ← BACKLOG M0-1 lives here
  │               (later: ∩ user policy — BACKLOG M2-4)
  ├─ 2. ROUTE     synthetic tool?  → SyntheticToolSet.dispatch(name, args, toolCtx)
  │               external tool?   → continue down
  ├─ 3. SCOPE     workspace path clamp (today's ScopedToolClient, unchanged logic)
  ├─ 4. OBSERVE   events + (later) audit log                 ← BACKLOG M2-5 hook
  └─ 5. TRANSPORT McpClientRegistry.callTool — neutral, knows nothing above
```

Key properties:

- **Advertisement ≡ enforcement.** `surfaceFor(role)` and the GATE layer are
  computed by the same `resolveAllowedTools(role, modelWhitelist, policy)`
  function. They cannot drift because there is one artifact.
- **Synthetic and external tools are uniform to callers.** Runners call
  `toolPort.dispatch(call, ctx)` and never know which kind they hit. The
  `executorRegistry.has(...)` branch in the orchestrator loop disappears.
- **Context-aware where context lives.** ToolContext (session, workspace,
  coordinator, tracker, signal) is bound by the runtime per turn — synthetic
  tool sets receive it at dispatch, not at construction. This kills the
  per-turn server churn (§2.2).

### 2.2 MCP clients become neutral; synthetic tools stop pretending to be servers

Today excel/subsessions are wrapped as in-process MCP *servers* so they can
ride the registry — at the cost of `refreshTurnServers` (tear down and
reconnect per turn, just to re-bind ToolContext) and a registry that knows
about turns.

Target:

- **`SyntheticToolSet`** interface: `{ name, descriptors(): ToolDescriptor[],
  dispatch(tool, args, toolCtx): Promise<ToolExecutionResult> }`. Excel,
  subsessions, and dispatch_executor each become one. Registered with the
  ToolPort, not the MCP registry.
- **`McpClientRegistry` shrinks to a transport**: register / connectAll /
  listTools / callTool / shutdown. Delete `refreshTurnServers`,
  `listToolsForOrchestrator`, `listToolsForExecutor`, and `READ_ONLY_TAILS`
  (classification moves to explicit per-server config consumed by
  `resolveAllowedTools` — same move BACKLOG M0-1/M2-3 already planned).
- `InProcessMcpServer` machinery stays only if a synthetic set ever needs to
  be exposed to an *external* MCP consumer; for our own loop it's dead weight.

### 2.3 Runners become thin loops over a `TurnContext`

The runtime prepares everything once per turn; runners receive it instead of
reaching back and rebuilding:

```ts
// runtime/turn-context.ts — assembled by AgentRuntime.beginTurn(options)
export interface TurnContext {
  conversation: ChatMessage[];        // the session's live transcript
  provider: LLMProvider;              // resolved for the runner's role
  surface: ToolSurface;               // descriptors for this role
  dispatch(call: ToolCall): Promise<ToolExecutionResult>;  // pre-bound ToolPort
  limits: OrchestrationConfig;
  tracker: DispatchTracker;
  drainInjected(): string[];          // pre-bound inbox
  emit: RunnerListener;
  signal?: AbortSignal;
}
```

`Orchestrator.run` decomposes into:

| Piece | Today (orchestrator.ts) | Target |
|---|---|---|
| Setup (L125–205): providers, filtering, registries, scoped client, synthetic ctx, server refresh | inline | `AgentRuntime.beginTurn()` → TurnContext |
| Summarization trigger (L133, L375–415) | private method | stays a runner concern, but calls `runtime.runners.summarizer()` |
| The loop (L207–341) | inline, with dispatch branching | `Orchestrator.loop(turn)` — ask → normalize → `turn.dispatch` → gate; no branching |
| Tool-call normalization (L484–527) | private method | move to `tool-adapter.ts` (it's provider-shape logic, not orchestration) |
| Completion gate + nudges (L253–288, L321–340) | inline | small `CompletionGate` class owning verdict→nudge-message policy |
| Usage accounting (L539–547) | orchestrator-only | TurnContext-owned, so executor/evaluator/summarizer count too (subsumes BACKLOG M1-2) |

Executor/Evaluator/Summarizer get the same treatment: constructed by the
RunnerFactory with a role-scoped TurnContext slice; `Executor.run` stops
building its own ScopedToolClient and filtered list (its surface arrives
pre-resolved, including the up-front "tool not in list" check — that's now
just the GATE answering).

### 2.4 Domain factories, executed by the runtime

Three factories, each owning one domain's construction policy; the runtime
is the only composition surface agents see:

```ts
// runtime/factories/registry-factory.ts
export class RegistryFactory {
  static async fromConfig(paths: { models: string; mcp: string; policies?: string }):
    Promise<{ models: ModelRegistry; mcp: McpClientRegistry; policy: PolicyRegistry }>;
}

// runtime/factories/runner-factory.ts — replaces `new X(runtime)` scattered in runners
export class RunnerFactory {
  constructor(private readonly runtime: AgentRuntimeQueryable) {}
  orchestrator(): Orchestrator;
  executor(): Executor;
  evaluator(): Evaluator;
  summarizer(): Summarizer;
}

// runtime/factories/runtime-factory.ts — replaces cli buildRuntime + buildSubRuntime
export class RuntimeFactory {
  constructor(private readonly deps: AgentRuntimeDeps) {}
  standard(opts: { sessionId?: string }): AgentRuntime;   // today's CLI pipeline
  child(refs: SubRuntimeRefs): AgentRuntime;              // today's buildSubRuntime
}
```

Access pattern: `runtime.tools` (the ToolPort), `runtime.runners` (the
RunnerFactory). A generic `runtime.create(kind)` string-dispatch is
deliberately **rejected** — typed facets keep IDE navigation and avoid a
stringly-typed service locator (the codebase has enough registry pattern
already; REGISTRY_PATTERN.md is honest about it being a service-locator
variant — don't add another lookup-by-name layer on top).

The middleware pipeline **stays** — it's good — but steps become thin calls
into factories (e.g. `OrchestratorMiddleware` body becomes
`ctx.toolPort = ToolPort.assemble(...); ctx.orchestrator = runners.orchestrator()`),
and `new Orchestrator(undefined as any)` dies: the orchestrator takes its
TurnContext per call, so it no longer needs the runtime at construction at
all.

### 2.5 The resulting interaction rule (the "glue" contract)

> An agent (runner) receives everything through its TurnContext and sends
> everything through `turn.dispatch`. It imports nothing from
> `registries/`, `synthetic-mcp/`, or `mcp-client.ts`. The runtime is the
> only module that composes those.

Enforceable mechanically: an eslint/Biome `no-restricted-imports` rule on
`runners/**` (add to BACKLOG M0-5's lint setup).

---

## 3. Migration plan (milestone MR in BACKLOG.md)

Ordered so the suite stays green after every step; each step is a separate
commit/PR-sized unit. Estimates are solo focused time.

### MR-1 · `resolveAllowedTools` + ToolPort skeleton with GATE — `~1.5d`
- Create `runtime/tool-port.ts`: constructor takes `{ mcpRegistry,
  modelRegistry, syntheticSets: [], workspaceId }`; implement
  `surfaceFor(role)` and `dispatch` with layers GATE → SCOPE → TRANSPORT
  (SCOPE = wrap existing `ScopedToolClient` unchanged; synthetic ROUTE comes
  in MR-3).
- One `resolveAllowedTools(role, registry)` function; replace the suffix
  heuristic with explicit per-server read/write config (move
  `READ_ONLY_TAILS` content into a config default so behavior is identical,
  marked for replacement by policies.json in M2-3).
- Tests: **this delivers BACKLOG M0-1** — write its acceptance tests here
  (orchestrator-named `fsmcp__write_file` denied; surface ≡ gate).

### MR-2 · Runtime owns the port; runners consume it — `~1d`
- `AgentRuntime.build()` constructs the ToolPort (new pipeline step or
  inside OrchestratorMiddleware); expose `runtime.getToolPort()`.
- `Orchestrator.run` and `Executor.run`: delete their local
  `ScopedToolClient` + `filterMcpByServerWhitelist` calls; use
  `toolPort.surfaceFor(...)` / `toolPort.dispatch(...)`. Behavior identical;
  the duplicated per-turn filtering is gone.
- Delete the descriptor assembly from `OrchestratorMiddleware` (it now asks
  the port), fixing the dual-assembly drift.

### MR-3 · Synthetic tool sets; neutral registry — `~2d`
- Define `SyntheticToolSet`; convert dispatch_executor (from
  `ExecutorRegistry`), subsessions, and excel to it. ToolContext is passed
  at dispatch (bound per turn by the runtime), not at construction.
- Register the three sets with the ToolPort; delete the
  `executorRegistry.has(...)` branch from the orchestrator loop —
  `turn.dispatch` is now the only call site.
- Delete `McpClientRegistry.refreshTurnServers`, `listToolsForOrchestrator`,
  `listToolsForExecutor`; delete `createSubsessionsMcpServer` /
  `createExcelMcpServer` server-wrappers (keep the tool implementations).
- Port the affected tests (`tests/registries/executor-registry.test.ts`,
  subsessions/excel server tests) to the new seams.

### MR-4 · `beginTurn` + TurnContext; orchestrator decomposition — `~2.5d`
- `AgentRuntime.beginTurn(options)` assembles TurnContext (provider,
  surface, pre-bound dispatch with session/workspace/tracker/signal/emit,
  limits, inbox drain). `dispatchAsync` creates it and hands it to the
  orchestrator.
- Split `Orchestrator.run`: `loop(turn)` keeps only the iteration logic;
  extract `CompletionGate` (verdict + nudge policy); move
  `normaliseAssistantTurn` into `tool-adapter.ts`.
- Move `accumulateUsage` into TurnContext so every role's provider calls are
  counted (**subsumes BACKLOG M1-2** — check it off there when this lands).
- Tests: existing orchestrator middleware/loop tests keep passing; add one
  test that executor + evaluator usage now appears in `session.counters`.

### MR-5 · Factories — `~1.5d`
- `RunnerFactory` (`runtime.runners`): replace `new Executor(this.runtime)`,
  `new Evaluator(this.runtime)`, `new Summarizer(this/runtime)` call sites.
- `RegistryFactory.fromConfig`: collapse the bootstrap block in
  `cli/index.ts` (ModelRegistry.load + McpClientRegistry construction) and
  give the future PolicyRegistry (M2-3) its slot.
- `RuntimeFactory` with `standard()` / `child()` presets: `cli/index.ts`
  `buildRuntime` and `build-sub-runtime.ts` become one-line calls; the
  pipeline definitions move next to each other so divergence between parent
  and child pipelines is visible in one file.

### MR-6 · Fence it — `~0.5d`
- Lint rule: `runners/**` may not import from `registries/`,
  `synthetic-mcp/`, `mcp-client`, `scoped-tool-client` (depends on M0-5
  lint setup; otherwise add a jest architecture test that greps imports).
- Update REGISTRY_PATTERN.md (ExecutorRegistry section is obsolete after
  MR-3) and the architecture diagram in README (already stale, see M0-7).
- Sweep: `ScopedToolClient` becomes an internal layer file of the port
  (rename to `tool-port/scope-layer.ts` or similar); delete dead exports
  from `synthetic-mcp/index.ts`.

**Total ≈ 9 focused days.** After MR, the BACKLOG items map as: M0-1 ✅ done
in MR-1, M1-2 ✅ done in MR-4, M2-4 = add the policy ∩ into
`resolveAllowedTools` (small), M2-5 (remote MCP bearer auth) = a new
transport in the neutral registry under the same gate, M2-6 (audit log) =
OBSERVE layer hook, M4-3/M4-4 = attach to the OBSERVE layer.

---

## 4. Sequencing vs. the existing backlog

Recommended: **MR-1/MR-2 before the rest of M0** (they ARE M0-1), then it's
a judgment call — either finish MR (momentum, everything else gets simpler)
or interleave the cheap M0 hygiene items (M0-2…M0-5) which touch disjoint
files. M2 (policy) should land **after** MR — `resolveAllowedTools` is its
natural home and doing policy first would mean writing it twice.

## 5. Acceptance — when is the refactor "done"

1. `grep -rn "ScopedToolClient\|filterMcpByServerWhitelist\|buildExecutorRegistry" src/agent/src/agent/runners/` → no hits.
2. `McpClientRegistry` has no method mentioning roles, turns, or refresh.
3. `Orchestrator.run` (or its successor `loop`) is under ~100 lines and
   contains no construction (`new`, `create*`, `build*`) except messages.
4. One test proves surface ≡ enforcement: a tool removed from
   `resolveAllowedTools` is simultaneously absent from `surfaceFor()` and
   denied by `dispatch()`.
5. `new Orchestrator(undefined as any)` no longer exists anywhere.
6. The 103 existing tests still pass (some relocated to the new seams).

## 6. Open naming/design decisions (pick once, early)

- [ ] Name: `RuntimeToolPort` vs `RuntimeMcpClient` vs `ToolGateway`.
      Recommendation: ToolPort — "Mcp" in the name would be wrong once
      synthetic sets aren't MCP, and "client" undersells that it gates.
- [ ] Does ToolPort own the DispatchTracker or does TurnContext? Recommend
      TurnContext (it's per-turn state; the port is per-session).
- [ ] Keep `InProcessMcpServer` plumbing for future external exposure of
      synthetic tools, or delete and re-add if ever needed? Recommend delete
      (YAGNI; git remembers).
