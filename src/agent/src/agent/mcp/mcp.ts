import type { ToolDescriptor } from "../providers/provider.js";
import type { TokenUsage } from "../session/session.js";

export interface ToolExecutionResult {
  isError: boolean;
  content: string;
  /**
   * Token cost the tool itself incurred (e.g. an executor dispatch running a
   * child model loop). The orchestrator folds this into the calling session's
   * counters, so delegated usage is part of the standard tool contract rather
   * than a side channel. Omitted by tools that consume no model tokens.
   */
  usage?: TokenUsage;
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
  /** Inject this server's per-model tool timeout; chainable for inline wiring. */
  setTimeout(t: number): Mcp;
  /**
   * Invoke a tool. `signal` is the caller's cutoff (rooted at the request's
   * source signal). The server wraps it in its own CancellationToken and adds
   * the injected timeout, so a cancel from above OR a local timeout collapses
   * the call. The tool only ever observes the resulting abort.
   */
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ToolExecutionResult>;
  shutdown(): Promise<void>;
}
