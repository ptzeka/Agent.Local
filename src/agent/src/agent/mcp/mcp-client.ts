import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { ToolDescriptor } from "../providers/provider.js";
import type { ToolExecutionResult } from "./mcp.js";

export type { ToolExecutionResult } from "./mcp.js";

/**
 * Minimal tool-dispatch surface. Both the concrete `McpClient` and the
 * per-workspace `ScopedToolClient` satisfy it, so callers that only need to
 * invoke a tool (the executor, the orchestrator's direct read calls) can depend
 * on the abstraction rather than the concrete client.
 */
export interface ToolInvoker {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>;
}

/**
 * Single-server MCP client.
 *
 * Wraps one MCP server connection. Manages tool discovery and invocation
 * for that server only. Stateless — returns POCO results to the caller,
 * which decides what to do (emit, log, etc.).
 */
export class McpClient {
  private tools: ToolDescriptor[];
  private readonly toolIndex = new Map<string, string>();
  constructor(
    private readonly serverName: string,
    private readonly client: Client,
    tools: ToolDescriptor[],
    signal?: AbortSignal
  ) {
    this.tools = tools;
    for (const tool of tools) {
      this.toolIndex.set(tool.name, tool.name);
    }
    // Self-disposal: nobody tracks clients for teardown — holding the owning
    // scope's signal IS the lifecycle contract.
    if (signal) {
      if (signal.aborted) {
        void this.shutdown();
      } else {
        signal.addEventListener("abort", () => void this.shutdown(), { once: true });
      }
    }
  }

  public get name(): string {
    return this.serverName;
  }

  public listTools(): ToolDescriptor[] {
    return this.tools.map((tool) => ({
      name: `${this.serverName}__${tool.name}`,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  public async callTool(toolName: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!this.toolIndex.has(toolName)) {
      return {
        isError: true,
        content: `Unknown tool "${toolName}" on server "${this.serverName}".`,
      };
    }

    try {
      const response = await this.client.callTool({
        name: toolName,
        arguments: args,
      });

      const text = extractTextContent(response.content);
      return {
        isError: response.isError === true,
        content: text,
      };
    } catch (err) {
      return {
        isError: true,
        content: `Tool "${toolName}" threw: ${(err as Error).message}`,
      };
    }
  }

  public async shutdown(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      // Best-effort
    }
  }

  public static async createFromConnection(
    serverName: string,
    client: Client,
    /** Owning scope's signal — the client closes itself when it aborts. */
    signal?: AbortSignal
  ): Promise<McpClient> {
    const toolsResponse = await client.listTools();
    const tools: ToolDescriptor[] = toolsResponse.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
    }));

    return new McpClient(serverName, client, tools, signal);
  }
}

function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block && (block as { type: string }).type === "text") {
      parts.push((block as { text?: string }).text ?? "");
    }
  }
  return parts.join("\n");
}
