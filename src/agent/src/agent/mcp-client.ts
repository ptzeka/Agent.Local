import fs from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { InProcessMcpServer } from "./synthetic-mcp/fs-server.js";
import type { ToolDescriptor } from "./providers/provider.js";

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

export interface ToolExecutionResult {
  isError: boolean;
  content: string;
}

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
  private workspaceRootValue: string;

  constructor(
    private readonly serverName: string,
    private readonly client: Client,
    tools: ToolDescriptor[],
    workspaceRoot: string
  ) {
    this.tools = tools;
    this.workspaceRootValue = workspaceRoot;

    for (const tool of tools) {
      this.toolIndex.set(tool.name, tool.name);
    }
  }

  public get name(): string {
    return this.serverName;
  }

  public get sandboxRoot(): string {
    return this.workspaceRootValue;
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
    workspaceRoot: string
  ): Promise<McpClient> {
    const toolsResponse = await client.listTools();
    const tools: ToolDescriptor[] = toolsResponse.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
    }));

    return new McpClient(serverName, client, tools, workspaceRoot);
  }
}

/**
 * Aggregates multiple single-server McpClient instances.
 *
 * Provides the same public interface as the old monolithic McpClient
 * but delegates to individual clients. Routes tool calls to the correct
 * server based on the namespaced tool name (`<server>__<tool>`).
 *
 * Handles:
 * - Tool discovery and filtering (by role)
 * - Per-turn server refresh (Excel, subsessions)
 * - Tool dispatch to the correct client
 */
export class McpClientRegistry {
  private clients = new Map<string, McpClient>();
  private readonly toolIndex = new Map<string, { serverName: string; toolName: string }>();
  private workspaceRootValue: string;

  constructor(workspaceRoot: string) {
    this.workspaceRootValue = workspaceRoot;
  }

  public get sandboxRoot(): string {
    return this.workspaceRootValue;
  }

  public registerClient(client: McpClient): void {
    this.clients.set(client.name, client);
    for (const tool of client.listTools()) {
      const match = tool.name.match(/^([^_]+)__(.+)$/);
      if (match) {
        const [, serverName, toolName] = match;
        this.toolIndex.set(tool.name, { serverName, toolName });
      }
    }
  }

  public listTools(): ToolDescriptor[] {
    const flattened: ToolDescriptor[] = [];
    for (const client of this.clients.values()) {
      flattened.push(...client.listTools());
    }
    return flattened;
  }

  public listToolsForOrchestrator(): ToolDescriptor[] {
    return this.listTools().filter((tool) => isOrchestratorTool(tool.name));
  }

  public listToolsForExecutor(): ToolDescriptor[] {
    return this.listTools();
  }

  public async callTool(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const lookup = this.toolIndex.get(name);
    if (!lookup) {
      const known = [...this.toolIndex.keys()].join(", ");
      return {
        isError: true,
        content: `Unknown tool "${name}". Available tools: ${known}`,
      };
    }

    const client = this.clients.get(lookup.serverName);
    if (!client) {
      return {
        isError: true,
        content: `Server "${lookup.serverName}" is no longer connected.`,
      };
    }

    return client.callTool(lookup.toolName, args);
  }

  public async refreshTurnServers(servers: { name: string; client: Client }[]): Promise<void> {
    const runtimeNames = new Set(servers.map((s) => s.name));

    for (const [key, val] of this.toolIndex) {
      if (runtimeNames.has(val.serverName)) {
        this.toolIndex.delete(key);
      }
    }

    for (const [serverName, client] of this.clients) {
      if (runtimeNames.has(serverName)) {
        this.clients.delete(serverName);
        await client.shutdown();
      }
    }

    for (const server of servers) {
      const client = await McpClient.createFromConnection(server.name, server.client, this.workspaceRootValue);
      this.registerClient(client);
    }
  }

  public async shutdown(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.shutdown();
    }
    this.clients.clear();
    this.toolIndex.clear();
  }

  public static async connect(
    configPath: string,
    workspaceRoot: string,
    inProcessServers: InProcessMcpServer[] = []
  ): Promise<McpClientRegistry> {
    const absolutePath = path.resolve(configPath);
    const raw = await fs.readFile(absolutePath, "utf8");
    const parsed = JSON.parse(raw) as McpConfigFile;

    if (!parsed.mcpServers || Object.keys(parsed.mcpServers).length === 0) {
      throw new Error(`${absolutePath} declares no mcpServers.`);
    }

    const registry = new McpClientRegistry(workspaceRoot);

    for (const inProcess of inProcessServers) {
      const client = await McpClient.createFromConnection(
        inProcess.serverName,
        inProcess.client,
        workspaceRoot
      );
      registry.registerClient(client);
    }

    for (const [serverName, serverConfig] of Object.entries(parsed.mcpServers)) {
      const connectedClient = await spawnServer(serverName, serverConfig, workspaceRoot);
      const client = await McpClient.createFromConnection(serverName, connectedClient, workspaceRoot);
      registry.registerClient(client);
    }

    return registry;
  }
}

async function spawnServer(
  serverName: string,
  config: McpServerConfig,
  workspaceRoot: string
): Promise<Client> {
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
  return client;
}

/**
 * Tool-name classifier shared by both role-scoped listings.
 *
 * The split is intentionally suffix-based so it survives renaming of the
 * MCP server prefix (`fsmcp__`, `codemcp__`, etc.). If we add a new
 * mutator (e.g. `powershell__exec`), add its tail name here.
 */
const READ_ONLY_TAILS = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "find_symbol",
  "get_file_context",
  "list_commits",
  "search_code",
  "excel__list_sheets",
  "excel__get_excel_columns",
  "excel__read_excel_sheet",
  "excel__query_excel_rows"
]);

function tail(toolName: string): string {
  const idx = toolName.indexOf("__");
  return idx === -1 ? toolName : toolName.slice(idx + 2);
}

function isOrchestratorTool(toolName: string): boolean {
  return READ_ONLY_TAILS.has(tail(toolName));
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
