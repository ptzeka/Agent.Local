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

## 0. Status — 2026-06-12 (executor as child runtime)

*Commits `89c558e`…`e742c2f`. Verified: `tsc --noEmit` clean, 29/29 suites,
138/138 tests.*

The executor design changed again — and settled. The 06-11 premise
("same-turn context separation, dormant stub") is **superseded**: the
executor is a sub-agent after all, but realized as a **full child runtime**,
not as the SyntheticToolSet/ExecutorRegistry machinery this plan drew in
§2.1/MR-3.

> **Superseded again (2026-08-02).** The dedicated executor was removed
> entirely — see the decision note at the top of [BACKLOG.md](BACKLOG.md). The
> child-runtime mechanics below are still exactly how delegation works; only the
> seam changed, from `executor__dispatch` to the generic `<role>__ask`.

> **Design (2026-06 shape):** `executor__dispatch` — a tool on the in-process
> `executor` LocalMcp (`synthetic-mcp/executor-server.ts`) — spawns a
> **brand-new child runtime per mutation** via `buildSubRuntime` with role
> `"executor"`: its own parent-linked session, its own conversation and
> persistence, its own context snapshot and registries. Nothing is shared
> with the parent besides the workspace. The child rides the *identical*
> middleware pipeline (`build-sub-runtime.ts`), so **every runtime feature is
> reused** — sessions, evaluator gate, summarization, resumability — with
> only the role prompt and tool whitelist differing. No second runner
> implementation, no hacked partial runtime.

Why this beats both prior shapes:

- **Privilege separation is structural, not advisory.** The orchestrator's
  whitelisted servers contain no write tools; the executor child's surface is
  resolved from *its* role's whitelist. The dispatch descriptor enumerates
  valid executor tool names dynamically (schema `enum`), so advertisement and
  enforcement derive from the same registry lookup.
- **Isolation by construction.** Dispatches cannot pollute each other or the
  parent transcript; a failed ask is simply dispatched again. The child's
  persisted session is the future resume point for the sub-task.
- **Cost flows back through the tool contract.** The child's counters return
  on `ToolExecutionResult.usage` and the parent folds them into its tally —
  delegated usage is part of the standard tool result, not a side channel
  (this lands the accounting half of MR-4 / BACKLOG M1-2).
- **The future policy gate has its seam.** `session.user` is inherited by
  every child (`InheritedUserMiddleware`), so a deterministic role check from
  `session.user` at the dispatch seam (policies.json ∩ whitelist, M2-3/M2-4)
  applies uniformly at every nesting level — one check, written once.

DispatchTracker is live again (per-turn caps, duplicate-mutation guard,
`recordSuccess`), and a promise-chain mutex serializes dispatches. The dead
`ExecutorRegistry`/`DispatchExecutorTool`/`syntheticContext` code is deleted;
`new Orchestrator(undefined as any)` is gone (acceptance item 5 ✅).

**Still open from this plan:** MR-4's decomposition half (orchestrator.ts is
~540 lines; TurnContext unbuilt), the MR-6 lint fence, and policies.json
(M2-3/M2-4). External MCP re-mounting is **done** — `external-mcp.ts` +
`mountExternalMcp` landed in commit `4855dfc`; codemcp and memomcp mount from
`mcp.json` at runtime.

**Gate reframe (2026-06-16):** tool-level access is structural via the
read/write server split (`fsmcp` vs `fsmcp-readonly`); no per-tool deny list
is needed. `resolveAllowedTools` = model whitelist ∩ user policy at **server**
granularity, enforced at mount time. Currently all sessions are anonymous so
the model whitelist is the effective set; user policy plugs in when M2-1/M2-3
land. The GATE layer in the ToolPort plan (§2.1) therefore simplifies: it is
`resolveAllowedTools` driving `mountServers`, not a dispatch-time deny list.

---

## 0-prev. Status — 2026-06-11 (after the wiring refactor) *(superseded by §0 above where they conflict)*

The refactor (commits `e1bd504`…`405e44a`) achieved much of this plan's
*intent* by a **simpler route than the plan prescribed**, and one design
premise changed underneath it:

> **Design change (superseded 2026-06-12, see §0):** the executor is now
> defined as *same-turn context
> separation*, not a sub-agent. `dispatch_executor` is an intentionally
> dormant stub; the orchestrator dispatches every tool of its whitelisted
> servers directly. §2.1's GATE/ROUTE layering and the `SyntheticToolSet`
> conversion (MR-3's first half) are therefore **superseded**, not pending.

Scorecard against the original problems (§1):

| §1 problem | Status |
|---|---|
| 1.1 Tool path scattered across five owners | **Largely fixed.** Role filtering = `getValidMcpForModel` server whitelist (suffix heuristic deleted); clamp + routing + events = `ScopedToolClient` (now fronts N servers); synthetic interception = gone (no synthetic tools in the loop); per-turn server churn = `refreshTurnServers` deleted. Owners are down to two: ModelRegistry (what) and ScopedToolClient (how). |
| 1.2 Tool assembly happens twice | **Fixed.** `OrchestratorMiddleware` no longer assembles descriptors; `Orchestrator.run` builds the surface once per turn from the registries. (`new Orchestrator(undefined as any)` still exists at `middleware/orchestrator.ts:29` — acceptance item 5 open; `setRuntime()` papers over it.) |
| 1.3 `Orchestrator.run` is a runaway | **Partly improved.** Executor-registry build, server refresh, and dispatch branching are gone, but setup (providers, scoped clients, config, context) is still inline and the method is still ~240 lines. `beginTurn`/TurnContext (MR-4) remains open if wanted. |
| 1.4 Factory sprawl | **Mostly fixed by middleware, not factories.** Construction now flows through pipeline steps (Configuration → Providers → Models → McpRegistry…) and `AgentRuntimeQueryable` getters. MR-5's RunnerFactory/RegistryFactory are unnecessary in this shape; `new Executor/Evaluator/Summarizer(runtime)` inside runners remains (acceptable — they're stateless). |

Acceptance checklist (§5) re-scored: (1) runners still import
`ScopedToolClient` — but it is now *the* sanctioned dispatch front, so the
criterion is obsolete as written; (2) ✅ registry has no role/turn/refresh
methods; (3) open; (4) holds trivially at **server** granularity (surface and
dispatch share `clientsFor(role)`); tool-level gating (M0-1) only matters if
per-tool policy returns; (5) open; (6) ✅ 25/25 suites, 111/111 tests, tsc
clean.

Loose ends the refactor left (detailed in PRODUCTION_READINESS §0.3):
evaluator wired to the summarizer's model; DispatchTracker inert (caps,
dedupe, mid-flight checks dead); subsessions tools unmounted; external MCP /
mcp.json disconnected (`ConnectMcpServersMiddleware` stubbed); dormant
`ExecutorRegistry`/`DispatchExecutorTool`/`syntheticContext` dead code; stale
prompts (`agentcontext.ts`) still teaching the model the old dispatch
contract.

**What of this plan survives as future work:** MR-4 (TurnContext + loop
decomposition + usage accounting for all roles), the lint fence (MR-6,
re-aimed at `runners/**` not importing registries directly), policies.json
intersection at the whitelist seam (M2-3/M2-4), and re-mounting external
servers behind the neutral registry. The rest of this document is kept as
the original design record.

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

### 2.0 The context model (read this first)

*Added 2026-06-16. The refactor is easier to reason about as a hierarchy of
**contexts**, each a projection of the one above. Every layer below is one
real object in the codebase; the table is the map.*

| Layer | Code today | Lifetime | Carries |
|---|---|---|---|
| **Runtime** | `AgentRuntime` | one CLI/headless run | owns the singletons, the root `scope` signal, the lifetime `events` bus |
| **RuntimeContext** | `RuntimeContext` (`runtime/types.ts`) | compiled once by `build()` | DI `Container` + config paths + `runtimeSignal` + `eventing` |
| **RunnerContext** | `runners/middleware/runner-middleware.ts` (shipped; absorbs `RunOptions` + the `this.runtime` pullbacks in MR-4·0) | one turn, **per runner** | DI handle (pass-through) + this turn's state (session/conversation/workspace) + glue (signal/emit) + state-derived artifacts (provider, surface, context snapshot, tracker) |
| **ToolContext** | `synthetic-mcp/types.ts` | one tool call | the subset tools need: `{ session, workspace, sandboxRoot, coordinator, signal }` — a projection of RunnerContext |
| **SubRuntimeRefs** | `runners/subsession.ts` | one sub-session spawn | the handshake: `{ sessionId, parentSessionId, workspaceId, user, standingContext, parentSignal }` — distilled from a ToolContext at the dispatch seam |

**Naming:** the orchestrator is just a *runner* — anything driven in the loop
(orchestrator, executor, evaluator, summarizer) is a runner and receives a
`RunnerContext`. There is no separate `TurnContext` type; where older sections
of this doc say "TurnContext", read **`RunnerContext`** (the shipped onion
context, extended to be the full per-turn bundle).

The chain is a **funnel** — each layer narrows the one above to exactly what
the next needs, and the bottom re-enters at the top for the child:

```
RuntimeContext        (DI + config, build-time)
  └─ RunnerContext          = DI (pass-through) + this turn's state + glue + artifacts
       └─ ToolContext            = the subset tools see, projected from RunnerContext
            └─ SubRuntimeRefs          = distilled at the spawn seam
                 └─ RuntimeContext'         (child) — buildSubRuntime mirrors the CLI
                                             pipeline, parent-fed instead of CLI-fed
```

Two rules make the funnel sound:

- **DI is singletons, so it rides through, not re-scoped.** There is no
  request/scoped container here — every registry is a process-wide singleton.
  So TurnContext carries the *same* DI handle verbatim; DI is *stateless
  resolution*, never part of "current state". `new Evaluator(di)` inside a
  runner is fine (resolution, not state). Only **state-derived** artifacts
  (provider-for-role, tool `surface`, context snapshot, `tracker`, scoped
  client, subsessions rebind) are computed per turn — those are what
  `beginTurn` builds onto the `RunnerContext` and what the loop must stop
  constructing (acceptance §5.3).

- **Signal cascades down; eventing bubbles up — and the spawn seam treats
  them differently.** `scope`(root) → `runtimeSignal` → turn `signal` →
  `ToolContext.signal` → `SubRuntimeRefs.parentSignal`: one cancel up high
  collapses everything below, transitively across the spawn boundary. Eventing
  is the mirror (turn bus chained under runtime bus chained under host) **except
  at the spawn seam**: a child is its *own* event root and reaches the parent
  through the executor MCP bridge (`bindTurn`), not by chaining under the parent
  bus (`build-sub-runtime.ts` — "no parent bus"). That asymmetry is why
  `SubRuntimeRefs` carries `parentSignal` but no parent `Eventing`:
  **cancellation is transitive, eventing is brokered.**

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

### 2.3 Runners become thin loops over a `RunnerContext`

*See §2.0 for what `RunnerContext` is in the funnel. The onion that folds
middleware around `run()` already shipped as `RunnerContext` /
`composeRunnerPipeline` — MR-4·0 keeps that name and extends it: it folds
`RunOptions` + the `this.runtime` pullbacks into the one `RunnerContext`,
retiring `Orchestrator.setRuntime`. The `TurnContext` name used in the prose
below is retired — read it as `RunnerContext`.*

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

### MR-1 · `resolveAllowedTools` + ToolPort skeleton — `~1.5d`
- Create `runtime/tool-port.ts`: constructor takes `{ mcpRegistry,
  modelRegistry, syntheticSets: [], workspaceId }`; implement
  `surfaceFor(role)` and `dispatch` with layers SCOPE → TRANSPORT
  (SCOPE = wrap existing `ScopedToolClient` unchanged; synthetic ROUTE comes
  in MR-3). No dispatch-time deny list — tool granularity is the read/write
  server split; unmounted servers are structurally unreachable.
- `resolveAllowedTools(modelRole, userPolicy, registry)` at **server**
  granularity: model whitelist ∩ user policy server allowlist. Called by
  `McpRegistryMiddleware.mountServers`; currently `userPolicy = anonymous`
  so model whitelist wins. User policy plugs in at M2-3 with no change here.
- Tests: **delivers BACKLOG M0-1 reframed** — a user policy excluding `fsmcp`
  causes it to be absent from both `surfaceFor()` and the mounted registry;
  anonymous policy leaves the model whitelist unchanged.

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
