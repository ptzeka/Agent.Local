# Registry Pattern Documentation

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

### 1. **ExecutorRegistry**
**File**: [src/agent/registries/executor-registry.ts](src/agent/src/agent/registries/executor-registry.ts)

**Purpose**: Single-tool wrapper that intercepts `dispatch_executor` calls.

**Key Design**:
- Holds exactly one synthetic tool: `DispatchExecutorTool`
- Acts as the LLM's only mutable entrypoint (reads are via MCP, writes go here)
- Routes orchestrator → executor sub-agent calls
- Returns results wrapped identically to real MCP responses

```typescript
constructor(executorTools: ToolDescriptor[])  // Takes tool list for the sub-agent
listDescriptors()  // Returns [dispatch_executor] to advertise to LLM
has(name: string)  // Checks if name === "dispatch_executor"
dispatch(name, args, context)  // Routes to executor tool handler
```

**Use Case**: Single point of control for all workspace mutations via a sub-agent.

---

### 2. **McpClientRegistry**
**File**: [src/agent/registries/mcp-registry.ts](src/agent/src/agent/registries/mcp-registry.ts)

**Purpose**: Aggregates multiple MCP servers under one interface.

**Key Design**:
- Holds multiple `McpClient` instances (one per MCP server)
- Indexes tools by namespaced name (`server__tool_name`)
- Filters tools by role (read-only vs. mutate)
- Supports dynamic server registration and per-turn refresh
- Two-phase initialization: register → connectAll

```typescript
constructor(workspaceRoot: string)
registerClient(client: McpClient)  // Add a connected client
registerInProcessServer(name, client)  // Queue an in-process server
connectAll(configPath)  // Finalize all connections at once
callTool(name, args)  // Route to correct client via index
listTools()  // All tools, flattened
listToolsForOrchestrator()  // Filter to read-only tools
refreshTurnServers(servers)  // Swap servers mid-session (Excel, subsessions)
```

**Tool Filtering Logic** (lines 241–263):
- Suffix-based classification (e.g., `read_file`, `write_file`) survives server renaming
- `READ_ONLY_TAILS` set determines orchestrator-safe tools
- Allows adding new mutators without code changes

**Use Case**: Provide a unified tool catalog from multiple independent MCP servers.

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

### 4. **ModelRegistry**
**File**: [src/agent/registries/model-registry.ts](src/agent/src/agent/registries/model-registry.ts)

**Purpose**: Maps roles to LLM providers and controls model/tool assignment.

**Key Design**:
- Holds multiple `LLMProvider` instances (one per model in models.json)
- Maps roles → model IDs (orchestrator, executor, summarizer, evaluator)
- Supports role aliasing for backward compatibility (coder → orchestrator)
- Per-model MCP server whitelisting
- Supports `AGENT_FORCE_MODEL` override at runtime

```typescript
getProviderForRole(role)  // Look up the provider for a role
getPromptTemplate(role)  // Return system prompt for the role
filterMcpByServerWhitelist(role, tools)  // Apply per-model MCP filter
assignRole(role, modelId)  // Hot-swap a role assignment
listRoles()  // All role→model assignments
```

**Defaults & Fallbacks** (lines 179–189):
- Orchestrator is mandatory; executor defaults to orchestrator's model
- Summarizer & evaluator fall back to orchestrator if not declared
- Forces role reassignment when `AGENT_FORCE_MODEL` is set

**Use Case**: Single source of truth for "which model/provider runs which role", decoupling agent code from model configuration.

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

### 1. **Two-Phase Initialization** (McpClientRegistry)
```typescript
// Phase 1: Register servers (called during middleware setup)
registry.registerInProcessServer("excel", excelClient);

// Phase 2: Connect everything together
await registry.connectAll(configPath);
```
Benefit: Allows dependencies between servers before they're all connected.

### 2. **Tool Filtering by Metadata** (ModelRegistry, McpClientRegistry)
```typescript
// Filter by suffix instead of server name → survives renaming
const suffix = toolName.substring(toolName.indexOf("__") + 2);
return READ_ONLY_TAILS.has(suffix);  // vs. hardcoded server names
```
Benefit: New tools don't require code changes, only config updates.

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

### Adding a New Tool Type to McpClientRegistry
Instead of modifying code:
1. Add the tool to an MCP server's manifest
2. Add its suffix to `READ_ONLY_TAILS` if read-only, or omit for mutating
3. Redeploy or restart the agent

---

## Summary

**The Registry Pattern in this codebase is a pragmatic, scoped variant of Service Locator** that provides:
- **Unified dispatch** for tools from multiple MCP servers
- **Role-based filtering** (orchestrator vs. executor capabilities)
- **Configuration-driven setup** (models.json, mcp.json control behavior)
- **Runtime flexibility** (hot-swapping, dynamic discovery)

It's **not a global anti-pattern** because registries are scoped, explicit, and passed as dependencies—making them more like **typed configuration containers** than untyped service finders.
