import type { TokenUsage } from "@agent-local/common/tokenusage";
import type { ToolDescriptor } from "./tooldescriptor.js";

export interface ToolExecutionResult {
  isError: boolean;
  content: string;
  // delegated child-loop cost folded into the calling session, so usage is part of the tool contract, not a side channel
  usage?: TokenUsage;
}

// minimal dispatch surface so callers that only invoke tools depend on this, not the concrete client
export interface ToolInvoker {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>;
}

// the registry's only view of a server: it never sees transports or processes
// satisfied by ExternalMcp (spawned stdio JSON-RPC) and LocalMcp (in-process handlers)
// contract: listTools advertises namespaced <name>__<tool>; callTool takes the bare name
export interface Mcp {
  readonly name: string;
  listTools(): ToolDescriptor[];
  // chainable for inline wiring
  setTimeout(t: number): Mcp;
  // signal is the caller's cutoff; the server wraps it with its timeout so the tool observes one abort
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ToolExecutionResult>;
  shutdown(): Promise<void>;
}
