/**
 * In-process subsessions MCP server.
 *
 * Like the Excel server, subsessions tools need per-turn context: the session's
 * coordinator, workspace, etc. This returns a factory that creates a fresh
 * Server+Client pair for each turn, with the context baked into the tool handlers.
 *
 * The returned `{ serverName, client }` pair is passed to McpClient as an
 * in-process server, indistinguishable from fsmcp, excel, or any spawned stdio server.
 * Tool names are namespaced as `subsessions__*` (e.g. `subsessions__create_subsession`).
 *
 * Architecture role: Repository / External layer. No orchestrator logic here —
 * just tool handlers and a thin MCP transport wrapper.

MCP (tool servers)
  ↓
Tool Descriptors (orchestrator visible)
  ├─ Real MCP tools (write, read, shell, etc.)
  ├─ executor__dispatch (synthetic)
  └─ subsessions__* tools (synthetic)
       ├─ create_subsession
       ├─ get_subsession_status
       ├─ finalize_subsession
       └─ list_subsessions
         ↓
[Orchestrator.ts interceptor]
  ├─ "executor__dispatch" → ExecutorLocalMcp->Orchestrator.run(role=executor)
  └─ "subsessions__*"   → SessionManager.createSubSession() / getStatus() / finalize()
         ↓
[Return feedback to Orchestrator's LLM]


 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

import { LocalMcp, type LocalTool } from "../mcp/local-mcp.js";
import { createSubSessionTools } from "./subsessions-tools/subsessions.js";
import type { SyntheticMcp, ToolContext } from "./types.js";

/** The MCP server name this module mounts under (tools namespace as `subsessions__*`). */
export const SUBSESSIONS_SERVER_NAME = "subsessions";

/**
 * Build a subsessions `LocalMcp` for a specific turn's context.
 *
 * Mirrors `createExcelLocalMcp`: each subsession tool is already a
 * `{ descriptor, callTool(args, ctx) }`, so we bind the turn's `ToolContext`
 * into a `LocalTool.invoke(args)` to satisfy the `Mcp` contract. Tool calls are
 * plain in-process function calls — no SDK `Server` or in-memory transport.
 *
 * The handlers' optional post-call `event` is dropped here (the `LocalMcp` path
 * carries only `{ isError, content }`), matching how Excel is mounted. When the
 * turn's `ToolContext.coordinator` is absent the tools still advertise, but each
 * call returns the handlers' own "sub-sessions are not available" error.
 */
export function createSubsessionsLocalMcp(toolCtx: ToolContext): LocalMcp {
  const tools: LocalTool[] = createSubSessionTools().map((tool) => ({
    descriptor: tool.descriptor,
    invoke: async (args) => {
      const result = await tool.callTool(args ?? {}, toolCtx);
      return { isError: result.isError, content: result.content };
    },
  }));

  return new LocalMcp(SUBSESSIONS_SERVER_NAME, tools);
}

/** A pre-connected in-process MCP server, ready for McpClient to mount. */
export interface InProcessMcpServer {
  serverName: string;
  client: Client;
}

/**
 * Build a subsessions MCP server+client pair for a specific turn's context.
 *
 * Each turn, the orchestrator calls this with that turn's `ToolContext` and an
 * emit callback. The returned client is already connected and ready for McpClient
 * to mount.
 *
 * This is an in-process server that needs per-turn recreation because subsession
 * tool handlers need access to that turn's coordinator and context.
 */
export function createSubsessionsMcpServer(toolCtx: ToolContext): InProcessMcpServer {
  const subsessionTools = createSubSessionTools();

  const toolsByName = new Map<string, SyntheticMcp>(
    subsessionTools.map((tool) => [tool.name, tool])
  );

  const toolListing: ListToolsResult = {
    tools: subsessionTools.map((tool) => ({
      name: tool.name,
      description: tool.descriptor.description,
      inputSchema: tool.descriptor.inputSchema as ListToolsResult["tools"][number]["inputSchema"],
    })),
  };

  const server = new Server(
    { name: "subsessions", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => toolListing);

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const toolName = request.params.name;
    const tool = toolsByName.get(toolName);

    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unknown tool: ${toolName}` }],
      };
    }

    try {
      const result = await tool.callTool(request.params.arguments ?? {}, toolCtx);
      return {
        content: [{ type: "text" as const, text: result.content }],
        isError: result.isError,
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: "agent-local-client-subsessions", version: "0.1.0" },
    { capabilities: {} }
  );

  void Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { serverName: "subsessions", client };
}
