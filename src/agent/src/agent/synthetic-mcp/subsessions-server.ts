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
  ├─ dispatch_executor (synthetic)
  └─ subsessions__* tools (synthetic)
       ├─ create_subsession
       ├─ get_subsession_status
       ├─ finalize_subsession
       └─ list_subsessions
         ↓
[Orchestrator.ts interceptor]
  ├─ "dispatch_executor" → createSubSessionTools->handleCreate->SessionManagercreateSubSession()
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

import { createSubSessionTools } from "./subsessions-tools/subsessions.js";
import type { SyntheticMcp, ToolContext } from "./types.js";

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
