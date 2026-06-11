import type { ToolDescriptor } from "../providers/provider.js";

export interface ToolExecutionResult {
  isError: boolean;
  content: string;
}

/**
 * Minimal tool-dispatch surface. Both the `McpRegistry` and the per-workspace
 * `ScopedToolClient` satisfy it, so callers that only need to invoke a tool
 * (the executor, the orchestrator's direct read calls) can depend on the
 * abstraction rather than the concrete client.
 */
export interface ToolInvoker {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>;
}

/**
 * A mounted MCP: a named server that owns a set of tools.
 *
 * This is the registry's only view of a server — it never sees transports or
 * processes. Two implementations exist:
 *
 *   - `ExternalMcp` — a spawned executable (e.g. codemcp) reached over stdio
 *     JSON-RPC; a genuinely separate service.
 *   - `LocalMcp`    — plain in-process code that looks like an MCP but invokes
 *     its tool handlers directly (fsmcp, excel, subsessions).
 *
 * Contract: `listTools()` advertises namespaced descriptors
 * (`<name>__<tool>`); `callTool()` takes the bare tool name — the registry
 * strips the namespace when routing.
 */
export interface Mcp {
  readonly name: string;
  listTools(): ToolDescriptor[];
  callTool(toolName: string, args: Record<string, unknown>): Promise<ToolExecutionResult>;
  shutdown(): Promise<void>;
}
