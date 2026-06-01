import fs from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { ToolDescriptor } from "./providers/provider.js";

/**
 * MCP client wrapper.
 *
 * Reads mcp.json, spawns each declared server as a child process over
 * stdio, and aggregates every tool exposed by every server into a single
 * flat table that the agent loop can iterate over.
 *
 * Tool names are namespaced by server (`<server>__<tool>`) so two servers
 * can both expose, say, `read_file` without colliding.
 */

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

interface ServerConnection {
  serverName: string;
  client: Client;
  tools: ToolDescriptor[];
}

export interface ToolExecutionResult {
  isError: boolean;
  content: string;
}

export class McpToolClient {
  private connections: ServerConnection[] = [];
  private readonly toolIndex = new Map<string, { serverName: string; toolName: string }>();

  /**
   * Static factory: reads mcp.json, launches every server, and waits for
   * each to advertise its tool list. Throws if any server fails to start.
   */
  public static async connect(configPath: string, workspaceRoot: string): Promise<McpToolClient> {
    const absolutePath = path.resolve(configPath);
    const raw = await fs.readFile(absolutePath, "utf8");
    const parsed = JSON.parse(raw) as McpConfigFile;

    if (!parsed.mcpServers || Object.keys(parsed.mcpServers).length === 0) {
      throw new Error(`${absolutePath} declares no mcpServers.`);
    }

    const client = new McpToolClient();

    for (const [serverName, serverConfig] of Object.entries(parsed.mcpServers)) {
      const connection = await client.startServer(serverName, serverConfig, workspaceRoot);
      client.connections.push(connection);

      for (const tool of connection.tools) {
        const exposedName = `${serverName}__${tool.name}`;
        client.toolIndex.set(exposedName, { serverName, toolName: tool.name });
      }
    }

    return client;
  }

  /**
   * Flat list of every tool from every connected server, with their names
   * already namespaced. This is what the provider sees as `tools`.
   */
  public listTools(): ToolDescriptor[] {
    const flattened: ToolDescriptor[] = [];

    for (const connection of this.connections) {
      for (const tool of connection.tools) {
        flattened.push({
          name: `${connection.serverName}__${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }

    return flattened;
  }

  /**
   * Dispatch a tool call. `name` is the namespaced form returned by `listTools`.
   * The result is shaped for re-injection as a `role: "tool"` message.
   */
  public async callTool(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const lookup = this.toolIndex.get(name);
    if (!lookup) {
      return {
        isError: true,
        content: `Unknown tool "${name}". Available tools: ${[...this.toolIndex.keys()].join(", ")}`,
      };
    }

    const connection = this.connections.find((c) => c.serverName === lookup.serverName);
    if (!connection) {
      return {
        isError: true,
        content: `Server "${lookup.serverName}" is no longer connected.`,
      };
    }

    try {
      const response = await connection.client.callTool({
        name: lookup.toolName,
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
        content: `Tool "${name}" threw: ${(err as Error).message}`,
      };
    }
  }

  public async shutdown(): Promise<void> {
    for (const connection of this.connections) {
      try {
        await connection.client.close();
      } catch {
        // Best-effort. The process is exiting anyway.
      }
    }
    this.connections = [];
    this.toolIndex.clear();
  }

  private async startServer(
    serverName: string,
    config: McpServerConfig,
    workspaceRoot: string
  ): Promise<ServerConnection> {
    // Merge the workspace root into the server's environment so the tools
    // process picks up the same scope the agent is configured with.
    // We filter out undefined values because StdioClientTransport's env type
    // requires Record<string, string>, but process.env may contain undefineds.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    for (const [key, value] of Object.entries(config.env ?? {})) {
      env[key] = value;
    }
    env.AGENT_WORKSPACE = workspaceRoot;

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env,
    });

    const client = new Client(
      {
        name: `agent-local-client-${serverName}`,
        version: "0.1.0",
      },
      {
        capabilities: {},
      }
    );

    await client.connect(transport);
    const toolsResponse = await client.listTools();

    const tools: ToolDescriptor[] = toolsResponse.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
    }));

    return { serverName, client, tools };
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
