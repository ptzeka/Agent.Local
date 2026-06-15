import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { CancellationToken } from "@agent-local/common/lifetime";
import type { ToolDescriptor } from "./tooldescriptor.js";
import type { Mcp, ToolExecutionResult } from "./mcp.js";

// wraps one MCP server connection; stateless, returns POCO results for the caller to act on
export class McpClient {
  private tools: ToolDescriptor[];
  private readonly toolIndex = new Map<string, string>();
  private timeout?: number;
  constructor(
    private readonly serverName: string,
    private readonly client: Client,
    tools: ToolDescriptor[],
    timeout?: number,
    signal?: AbortSignal
  ) {
    this.tools = tools;
    this.timeout = timeout;
    for (const tool of tools) {
      this.toolIndex.set(tool.name, tool.name);
    }
    // self-disposal: nobody tracks clients for teardown, so the owning scope's signal is the lifecycle
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

  // mirrors LocalMcp so both server kinds satisfy the same Mcp wiring contract
  public setTimeout(t: number): Mcp {
    this.timeout = t;
    return this as unknown as Mcp;
  }

  public listTools(): ToolDescriptor[] {
    return this.tools.map((tool) => ({
      name: `${this.serverName}__${tool.name}`,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  public async callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ToolExecutionResult> {
    if (!this.toolIndex.has(toolName)) {
      return {
        isError: true,
        content: `Unknown tool "${toolName}" on server "${this.serverName}".`,
      };
    }

    // a cancel from above OR a local timeout must abort the RPC, so wrap both into one token
    const cutoff = new CancellationToken(signal);
    let timer: NodeJS.Timeout | null = null;
    try {
      if (this.timeout && this.timeout > 0) {
        timer = setTimeout(() => {
          if (!cutoff.cancelled) {
            cutoff.cancel(`Tool "${this.serverName}__${toolName}" timed out after ${this.timeout}ms.`);
          }
        }, this.timeout);
      }
      const response = await this.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { signal: cutoff.signal }
      );

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
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public async shutdown(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      // best-effort: a failed close on teardown has nowhere useful to surface
    }
  }

  public static async createFromConnection(
    serverName: string,
    client: Client,
    // owning scope's signal: the client closes itself when it aborts
    signal?: AbortSignal
  ): Promise<McpClient> {
    const toolsResponse = await client.listTools();
    const tools: ToolDescriptor[] = toolsResponse.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
    }));

    return new McpClient(serverName, client, tools, undefined, signal);
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
