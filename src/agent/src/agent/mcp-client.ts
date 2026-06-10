import fs from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { InProcessMcpServer } from "./synthetic-mcp/fs-server.js";
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

/**
 * Minimal tool-dispatch surface. Both the concrete `McpToolClient` and the
 * per-workspace `ScopedToolClient` satisfy it, so callers that only need to
 * invoke a tool (the executor, the orchestrator's direct read calls) can depend
 * on the abstraction rather than the concrete client.
 */
export interface ToolInvoker {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>;
}

export class McpToolClient {
  private connections: ServerConnection[] = [];
  private readonly toolIndex = new Map<string, { serverName: string; toolName: string }>();
  /**
   * The file-sandbox container root every server was launched against
   * (AGENT_WORKSPACE). Captured at connect so in-process consumers — e.g. the
   * synthetic Excel tools — resolve files to the SAME root fsmcp writes to,
   * rather than re-deriving it from the environment.
   */
  private workspaceRootValue = "";

  /**
   * Static factory: reads mcp.json, launches every server, and waits for
   * each to advertise its tool list. Throws if any server fails to start.
   *
   * `inProcessServers` are already-connected in-process MCP servers (e.g. the
   * filesystem `fsmcp` server) linked over an in-memory transport. They are
   * registered through the SAME path as spawned servers, so an in-process MCP
   * server is indistinguishable from one launched over stdio.
   */
  public static async connect(
    configPath: string,
    workspaceRoot: string,
    inProcessServers: InProcessMcpServer[] = []
  ): Promise<McpToolClient> {
    const absolutePath = path.resolve(configPath);
    const raw = await fs.readFile(absolutePath, "utf8");
    const parsed = JSON.parse(raw) as McpConfigFile;

    if (!parsed.mcpServers || Object.keys(parsed.mcpServers).length === 0) {
      throw new Error(`${absolutePath} declares no mcpServers.`);
    }

    const client = new McpToolClient();
    client.workspaceRootValue = workspaceRoot;

    // Register pre-connected in-process servers first so their namespaced names
    // are resolvable the moment any server-backed tool runs.
    for (const inProcess of inProcessServers) {
      await client.registerConnection(inProcess.serverName, inProcess.client);
    }

    for (const [serverName, serverConfig] of Object.entries(parsed.mcpServers)) {
      const connectedClient = await client.spawnServer(serverName, serverConfig, workspaceRoot);
      await client.registerConnection(serverName, connectedClient);
    }

    return client;
  }

  /** The file-sandbox container root all servers were launched against. */
  public get sandboxRoot(): string {
    return this.workspaceRootValue;
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
   * Read-only context tools the ORCHESTRATOR is allowed to call directly.
   * The split is by tool-name suffix so it works regardless of which MCP
   * server provides the tool. Mutating tools are off-limits — the only
   * way the orchestrator can mutate is through `dispatch_executor`.
   */
  public listToolsForOrchestrator(): ToolDescriptor[] {
    return this.listTools().filter((tool) => isOrchestratorTool(tool.name));
  }

  /**
   * Full tool surface the EXECUTOR is allowed to call: mutators plus the
   * read tools it needs for the validation step.
   */
  public listToolsForExecutor(): ToolDescriptor[] {
    return this.listTools().filter((tool) => isExecutorTool(tool.name));
  }

  /**
   * Register an additional connection at runtime (e.g. per-turn in-process server).
   * Idempotent: registering the same serverName twice replaces the prior connection.
   * Used by the orchestrator to mount a fresh Excel server each turn with
   * that turn's context.
   */
  public async registerRuntimeConnection(serverName: string, client: Client): Promise<void> {
    await this.registerConnection(serverName, client);
  }

  /**
   * Dispatch a tool call. `name` is the namespaced form returned by `listTools`.
   * The result is shaped for re-injection as a `role: "tool"` message.
   */
  public async callTool(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const lookup = this.toolIndex.get(name);
    if (!lookup) {
      const known = [...this.toolIndex.keys()].join(", ");
      return {
        isError: true,
        content: `Unknown tool "${name}". Available tools: ${known}`,
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

  /**
   * Spawn a server declared in mcp.json over stdio and return its connected
   * Client. Tool discovery and indexing happen in `registerConnection`, which
   * an in-process server reaches through the same path.
   */
  private async spawnServer(
    serverName: string,
    config: McpServerConfig,
    workspaceRoot: string
  ): Promise<Client> {
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
    return client;
  }

  /**
   * Index a connected Client under `serverName`: ask it for its tool list and
   * register each tool under the `<server>__<tool>` namespace. Used identically
   * for spawned (stdio) and in-process (in-memory) servers — once a Client is
   * connected, McpToolClient can't tell them apart.
   */
  private async registerConnection(serverName: string, client: Client): Promise<void> {
    const toolsResponse = await client.listTools();

    const tools: ToolDescriptor[] = toolsResponse.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
    }));

    this.connections.push({ serverName, client, tools });

    for (const tool of tools) {
      const exposedName = `${serverName}__${tool.name}`;
      this.toolIndex.set(exposedName, { serverName, toolName: tool.name });
    }
  }
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
]);

const MUTATING_TAILS = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "exec",
  "shell",
  "powershell",
  "run_command",
]);

function tail(toolName: string): string {
  const idx = toolName.indexOf("__");
  return idx === -1 ? toolName : toolName.slice(idx + 2);
}

function isOrchestratorTool(toolName: string): boolean {
  return READ_ONLY_TAILS.has(tail(toolName));
}

function isExecutorTool(toolName: string): boolean {
  const t = tail(toolName);
  return READ_ONLY_TAILS.has(t) || MUTATING_TAILS.has(t);
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
