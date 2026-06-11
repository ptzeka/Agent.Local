# Registry Pattern Documentation

> **Updated 2026-06-11** after the wiring refactor: registries are now built by
> middleware pipeline steps and reached through `AgentRuntimeQueryable`
> getters; `McpClientRegistry` shrank to a neutral transport; configuration
> and provider construction split into two new registries; `ExecutorRegistry`
> is dormant.

## Overview

This codebase uses the **Registry Pattern**, a variant of the Service Locator pattern that acts as a centralized lookup and dispatch mechanism for dependencies. Rather than injecting dependencies at construction time, registries hold references that are looked up at runtime.

## Pattern Structure

### Core Concept

A registry is a stateful container that:
1. **Registers** resources (tools, clients, models, workspaces) into an in-memory map
2. **Resolves** lookups by name/identifier
3. **Dispatches** calls to the appropriate handler
4. **Filters/transforms** the resource list based on context (role, capabilities, etc.)

### Common Methods Across Registries

| Method | Purpose | Example |
|--------|---------|---------|
| `register*()` | Add a resource to the registry | `registerClient()`, `register()` |
| `get()` / `has()` | Check existence and retrieve | `get(workspaceId)`, `has(name)` |
| `list*()` | Return all resources, optionally filtered | `listTools()`, `listRoles()` |
| `dispatch()` / `call*()` | Route to handler, return result | `dispatch(name, args)`, `callTool()` |

---

## Registries in This Codebase

### 1. **ExecutorRegistry** *(dormant)*
**File**: [executor-registry.ts](src/agent/src/agent/registries/executor-registry.ts)

Wrapped the synthetic `dispatch_executor` tool. The orchestrator loop no
longer intercepts synthetic tools — it dispatches every call through
`ScopedToolClient` — so this registry (and `DispatchExecutorTool` behind it)
is currently **dead code, intentionally left in place**. Per the agreed
design, the executor is same-turn context separation, not a sub-agent; do not
re-wire this as an LLM handoff.

---

### 2. **McpClientRegistry** *(now a neutral transport)*
**File**: [mcp-registry.ts](src/agent/src/agent/registries/mcp-registry.ts)

**Purpose**: Holds the mounted MCP servers (`Mcp` instances) for a session.
Nothing more — it no longer filters by role, dispatches calls, or refreshes
per-turn servers.

```typescript
constructor(workspaceRoot: string)   // exposes `sandboxRoot`
registerClient(client: Mcp)          // mount a server by name
getClient(serverName)                // lookup for role resolution
listTools()                          // all tools, flattened (namespaced)
```

`Mcp` ([mcp/mcp.ts](src/agent/src/agent/mcp/mcp.ts)) is the registry's only
view of a server. Two implementations: `LocalMcp` (in-process function
dispatch — fsmcp, excel) and `McpClient` (external stdio server). Dispatch
now happens in `ScopedToolClient`, which fronts the servers resolved for a
role and routes `<server>__<tool>` calls.

The removed surface — `callTool`, `connectAll`/`spawnServer`,
`refreshTurnServers`, `listToolsForOrchestrator`, the `READ_ONLY_TAILS`
suffix classifier — is gone for good: role→tool resolution moved to
`ModelRegistry.getValidMcpForModel` (server-name whitelist per model), and
external-server spawning is stubbed out pending re-introduction in
`ConnectMcpServersMiddleware`.

---

### 2a. **ConfigurationRegistry** *(new)*
**File**: [configuration-registry.ts](src/agent/src/agent/registries/configuration-registry.ts)

**Purpose**: Single owner of `models.json` — loads it once, validates
non-emptiness, merges `orchestration` over defaults, and caches the parsed
`ModelsFile`. Every other registry (and the orchestrator's per-turn limits)
reads through it, so config I/O happens in exactly one place.

```typescript
constructor(configPath: string)
getModelsConfiguration(): Promise<ModelsFile>   // cached after first read
```

---

### 2b. **ProvidersRegistry** *(new)*
**File**: [providers-registry.ts](src/agent/src/agent/registries/providers-registry.ts)

**Purpose**: Instantiates one `LLMProvider` per role-referenced model and
hands them out by model id. Splits "which SDK client talks to which model"
away from `ModelRegistry`, which now only maps roles.

```typescript
constructor(modelsFile: ModelsFile)
loadModels()                 // build providers for role-referenced models
getProvider(modelId)         // LLMProvider instance
getModel(modelId)            // ModelDefinition
```

Note: it reads API keys from `process.env` at `loadModels()` time, and it
only builds providers for models that appear in `roles` (the inline comment
still claims every declared model — drift to fix).

---

### 3. **WorkspaceRegistry**
**File**: [src/agent/registries/workspace-registry.ts](src/agent/src/agent/registries/workspace-registry.ts)

**Purpose**: Repository layer mapping workspace IDs to their state.

**Key Design**:
- Holds `{ workspaceId, root, projectContext }` tuples
- Loads `agentcontext.md` once per workspace (caches thereafter)
- Enables multiple sessions to share workspace state
- Idempotent register: joining an existing workspace is cheap

```typescript
register(workspaceId, root)  // Load context, cache result
get(workspaceId)  // Retrieve cached entry (throws if missing)
reload(workspaceId)  // Re-read agentcontext.md, pick up edits
```

**Standing Direction**: Multiple sessions sharing a `workspaceId` automatically share the same project context, making "several sessions working toward a common goal" coherent.

**Use Case**: Decouple session creation from context loading; enable shared workspace semantics.

---

### 4. **ModelRegistry** *(slimmed: ~335 → ~73 lines)*
**File**: [model-registry.ts](src/agent/src/agent/registries/model-registry.ts)

**Purpose**: Pure role mapping over the parsed `ModelsFile`. Provider
construction moved to `ProvidersRegistry`; file loading to
`ConfigurationRegistry`.

```typescript
constructor(modelsFile: ModelsFile)
getProviderForRole(role)      // role → model id (string, not a provider)
getPromptTemplate(role)       // system prompt (project/orchestrator/executor only)
getValidMcpForModel(role)     // role → model → its `mcp` server-name whitelist
assignRole(role, modelId)     // hot-swap (validates the model exists)
getRoles() / getValidModels()
```

`getValidMcpForModel` is now the **only** role→tools mechanism: callers
resolve each whitelisted server via `McpClientRegistry.getClient` (unmounted
names are skipped silently) and front the result with a `ScopedToolClient`.

**Dropped in the refactor — all confirmed deliberate**: role fallbacks
(executor/summarizer/evaluator defaulting to orchestrator), role-alias
handling, `AGENT_FORCE_MODEL` (dynamic config is the sole source of truth —
no env-var overrides), and load-time role↔model validation (consistency is
the config *producer's* contract, upstream of the runtime).

---

## Pattern Comparison

### Service Locator (Anti-Pattern vs. Pragmatic Tool)

| Aspect | Traditional Service Locator | This Implementation |
|--------|----------------------------|-------------------|
| **Scope** | Global, application-wide | Per-request or per-initialization; scoped containers |
| **Coupling** | Tight; any code can find any service | Reduced; registries passed as dependencies to handlers |
| **Testability** | Hard; hidden dependencies | Medium; easier when registries are constructor parameters |
| **Discoverability** | Type signature doesn't reveal needs | Clear in method signatures |

**Verdict**: This is a **pragmatic locator**, not an anti-pattern, because:
- Registries are **scoped per request** (not global singletons)
- They're passed **explicitly as constructor/method parameters**, reducing hidden coupling
- They act as **configuration containers**, not generic service finders
- The registry types themselves encode what's available (type safety)

---

### Dependency Injection Alternative

If we rewrote with traditional DI:
```typescript
// Current (Registry):
constructor(registry: McpClientRegistry) {
  const result = registry.callTool(name, args);
}

// Alternative (Injected):
constructor(tools: Map<string, ToolHandler>) {
  const handler = tools.get(name);
  const result = await handler.call(args);
}
```

**Trade-offs**:
- **DI Advantages**: Stricter type safety, easier to mock, explicit dependencies
- **Registry Advantages**: Dynamic discovery, runtime filtering (e.g., by role), deferred connection (two-phase init), hot-swapping (e.g., `assignRole()`)

This codebase chose registries because:
1. Tools/roles are **context-dependent** (orchestrator ≠ executor in terms of allowed tools)
2. **Configuration-driven** (models.json, mcp.json drive behavior, not code)
3. **Deferral needed**: Two-phase initialization (register in-process servers before connecting)
4. **Runtime swapping**: `refreshTurnServers()`, `assignRole()` require mutable state

---

## Trade-offs & Design Decisions

### Pros
✅ **Single point of control**: All tool routing flows through the registry  
✅ **Context-aware filtering**: Same tool set, different results for different roles  
✅ **Configuration-driven**: Swap models/servers by editing JSON, not code  
✅ **Dynamic**: Tools/models can be added, removed, or reassigned at runtime  
✅ **Two-phase init**: Allows deferred connection (critical for in-process servers)  

### Cons
❌ **Hidden dependencies**: Code doesn't declare what it needs (mitigated by explicit constructor params)  
❌ **Runtime errors**: Lookup failures happen at call time, not at start  
❌ **Testing complexity**: Registries must be set up before tests; harder to isolate  
❌ **Less type-safe than DI**: Tool names are strings, not types  

### Mitigation Strategies
- **Registries are passed as constructor parameters**, not fetched globally
- **Validation at initialization**: `ModelRegistry.load()` checks all roles/models exist
- **Clear method signatures**: `dispatch(name: string, args: Record<string, unknown>)` shows what's needed
- **Comprehensive validation**: MCPClientRegistry checks server existence before dispatch

---

## When to Use This Pattern

### ✅ Good Fit
- **Configuration-driven services** (models, servers, roles defined in JSON)
- **Multi-protocol dispatch** (multiple MCP servers with unified interface)
- **Context-dependent behavior** (same tool, different access based on role)
- **Runtime discovery** (list available tools, models, roles dynamically)
- **Deferred initialization** (two-phase setup needed)

### ❌ Poor Fit
- **Simple dependency injection** (just injecting a single service, no discovery needed)
- **Type-critical code** (prefer `Record<string, Handler>` or classes for type safety)
- **Testing-heavy** (registries add setup complexity; traditional DI is simpler)

---

## Key Implementation Patterns

### 1. **Pipeline-Step Construction** (all registries)
```typescript
// Each registry is built by one middleware step, in dependency order:
new AgentRuntime(deps)
  .add(new ConfigurationMiddleware({ configPath }))  // ConfigurationRegistry
  .add(new ProvidersMiddleware())                    // ProvidersRegistry
  .add(new ModelsMiddleware())                       // ModelRegistry
  .add(new McpRegistryMiddleware())                  // McpClientRegistry + LocalMcps
```
Benefit: one composition root; `AgentRuntime.build()` verifies every owned
field was produced and reports all gaps at once. (Replaces the old two-phase
`register → connectAll` — `connectAll` is deleted; external-server spawning
will return via the currently-stubbed `ConnectMcpServersMiddleware`.)

### 2. **Per-Model Server Whitelist** (ModelRegistry)
```typescript
// role → model → models.json `mcp` list → mounted Mcp clients
const clients = models.getValidMcpForModel(role)
  .flatMap((name) => { const c = mcp.getClient(name); return c ? [c] : []; });
const scoped = new ScopedToolClient(clients, workspaceId, emit);
```
Benefit: surface and dispatch derive from the same server set, so they cannot
drift — but the granularity is server-level. The old `READ_ONLY_TAILS`
suffix classifier is deleted; if read-only restriction returns, the agreed
mechanism is a dedicated read-only MCP server, not a name filter.

### 3. **Idempotent Registration** (WorkspaceRegistry)
```typescript
register(id: string) {
  if (this.workspaces.has(id)) return this.workspaces.get(id);
  // ... load & cache
}
```
Benefit: Safe to call multiple times; joining a workspace is cheap.

### 4. **Fallback Resolution** (ModelRegistry)
```typescript
if (!this.roleAssignments.has("executor")) {
  this.roleAssignments.set("executor", this.roleAssignments.get("orchestrator")!);
}
```
Benefit: Single-model setups work without declaring every role.

---

## Integration Points

**Where Registries Are Built**:
- [src/agent/middleware/](src/agent/src/agent/middleware/) — Initializers construct registries during context setup
- Passed to handlers as constructor parameters

**Where Registries Are Used**:
- Orchestrator & Executor for tool dispatch
- System prompt generation (ModelRegistry)
- Tool filtering & capability negotiation
- Workspace-aware session management

---

## Extending This Pattern

### Adding a New Registry
```typescript
export class FooRegistry {
  private readonly items = new Map<string, Item>();

  public register(id: string, item: Item): void {
    this.items.set(id, item);
  }

  public get(id: string): Item {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unknown id "${id}".`);
    return item;
  }

  public list(): Item[] {
    return [...this.items.values()];
  }
}
```

### Adding a New Tool to the Catalog
1. For in-process tools: add a `LocalTool` to the server's `createXxxLocalMcp`
   factory (see [fs-server.ts](src/agent/src/agent/synthetic-mcp/fs-server.ts))
2. Add the server's name to the `mcp` whitelist of each model that should see
   it in `models.json`
3. Restart the agent — no registry code changes

---

## Summary

**The Registry Pattern in this codebase is a pragmatic, scoped variant of Service Locator** that provides:
- **A unified tool catalog** from multiple mounted servers (`LocalMcp` + external)
- **Per-model server whitelisting** (role → model → `mcp` list)
- **Configuration-driven setup** (models.json controls behavior; mcp.json pending reconnection)
- **Runtime flexibility** (role hot-swapping via `assignRole`)

Since the 2026-06 refactor, registries are also **construction-disciplined**:
each is produced by exactly one middleware pipeline step and consumed through
`AgentRuntimeQueryable` getters, eliminating the ad-hoc point-to-point
imports the original write-up flagged as the pattern's main risk.

It's **not a global anti-pattern** because registries are scoped, explicit, and passed as dependencies—making them more like **typed configuration containers** than untyped service finders.
