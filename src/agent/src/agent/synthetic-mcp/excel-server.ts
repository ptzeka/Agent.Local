/**
 * In-process Excel MCP server.
 *
 * Unlike fsmcp (which needs only a static workspace root), Excel tools need
 * per-turn context: the session's workspace ID, the executor, the abort signal, etc.
 * So this returns a factory that creates a fresh Server+Client pair for each turn,
 * with the context baked into the tool handlers.
 *
 * The returned `{ serverName, client }` pair is passed to McpClient as an
 * in-process server, indistinguishable from fsmcp or any spawned stdio server.
 * Tool names are namespaced as `excel__*` (e.g. `excel__read_sheet`).
 *
 * Architecture role: Repository / External layer. No orchestrator logic here —
 * just tool handlers and a thin MCP transport wrapper.
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

import type { ToolDescriptor } from "../providers/provider.js";
import { createExcelTools } from "./excel-tools/excel-tools.js";
import type { SyntheticTool, SyntheticToolContext } from "./types.js";

/** A pre-connected in-process MCP server, ready for McpClient to mount. */
export interface InProcessMcpServer {
  serverName: string;
  client: Client;
}

/**
 * Build an Excel MCP server+client pair for a specific turn's context.
 *
 * Each turn, the orchestrator calls this with that turn's `SyntheticToolContext`,
 * which includes the workspace, session, executor, etc. The returned client is
 * already connected and ready for McpClient to mount.
 *
 * This is the only in-process server that needs per-turn recreation, because
 * Excel tool handlers need access to that turn's workspace + session state.
 */
export function createExcelMcpServer(context: SyntheticToolContext): InProcessMcpServer {
  const excelTools = createExcelTools();

  // Map bare tool names to their handlers, binding context.
  const toolsByName = new Map<string, SyntheticTool>(
    excelTools.map((tool) => [tool.name, tool])
  );

  const toolListing: ListToolsResult = {
    tools: excelTools.map((tool) => ({
      name: tool.name,
      description: tool.descriptor.description,
      inputSchema: tool.descriptor.inputSchema as ListToolsResult["tools"][number]["inputSchema"],
    })),
  };

  const server = new Server(
    { name: "excel", version: "0.1.0" },
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
      const result = await tool.callTool(request.params.arguments ?? {}, context);
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
    { name: "agent-local-client-excel", version: "0.1.0" },
    { capabilities: {} }
  );

  // Connect both synchronously (we're in-process).
  void Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { serverName: "excel", client };
}
