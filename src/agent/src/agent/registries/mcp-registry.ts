import fs from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { InProcessMcpServer } from "../synthetic-mcp/fs-server.js";
import type { ToolDescriptor } from "../providers/provider.js";
import { McpClient, ToolInvoker, type ToolExecutionResult } from "../mcp-client.js";

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
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
 *
 * Two-phase initialization:
 *   1. Constructor + registerInProcessServer() — collect servers
 *   2. connectAll() — connect everything at once (stdio + in-process)
 */
export class McpClientRegistry implements ToolInvoker {
  private clients = new Map<string, McpClient>();
  private readonly toolIndex = new Map<string, { serverName: string; toolName: string }>();
  private workspaceRootValue: string;
  private pendingServers = new Map<string, Client>();

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

  /**
   * Register an in-process server (e.g., Excel, subsessions) for later connection.
   * Called during middleware setup when context becomes available.
   * Connection happens later in connectAll().
   */
  public registerInProcessServer(name: string, client: Client): void {
    this.pendingServers.set(name, client);
  }

  /**
   * Connect all registered in-process servers plus stdio servers from mcp.json.
   * Called once after all servers are registered, before orchestrator runs.
   */
  public async connectAll(configPath: string): Promise<void> {
    const absolutePath = path.resolve(configPath);
    const raw = await fs.readFile(absolutePath, "utf8");
    const parsed = JSON.parse(raw) as McpConfigFile;

    if (!parsed.mcpServers || Object.keys(parsed.mcpServers).length === 0) {
      throw new Error(`${absolutePath} declares no mcpServers.`);
    }

    // Connect all pending in-process servers first
    for (const [serverName, client] of this.pendingServers) {
      const mcpClient = await McpClient.createFromConnection(serverName, client, this.workspaceRootValue);
      this.registerClient(mcpClient);
    }
    this.pendingServers.clear();

    // Connect all stdio servers from mcp.json
    for (const [serverName, serverConfig] of Object.entries(parsed.mcpServers)) {
      const connectedClient = await spawnServer(serverName, serverConfig, this.workspaceRootValue);
      const client = await McpClient.createFromConnection(serverName, connectedClient, this.workspaceRootValue);
      this.registerClient(client);
    }
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
  "read_excel_sheet",
  "get_excel_columns",
  "query_excel_rows",
  "list_sheets"
]);

function tail(toolName: string): string {
  const idx = toolName.indexOf("__");
  return idx === -1 ? toolName : toolName.slice(idx + 2);
}

function isOrchestratorTool(toolName: string): boolean {
  return READ_ONLY_TAILS.has(tail(toolName));
}
