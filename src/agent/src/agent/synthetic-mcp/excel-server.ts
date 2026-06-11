/**
 * In-process Excel MCP server.
 *
 * Unlike fsmcp (which needs only a static workspace root), Excel tools need
 * per-turn context: the session's workspace ID, the abort signal, etc. So this
 * returns a `LocalMcp` whose tool handlers have that turn's `ToolContext` baked
 * in.
 *
 * Like fsmcp, the tools are exposed directly as a `LocalMcp` — a tool call is a
 * plain in-process function call, not a JSON-RPC round-trip over an in-memory
 * transport. To every consumer it is indistinguishable from a spawned stdio
 * server. Tool names namespace as `excel__*` (e.g. `excel__read_sheet`).
 *
 * Architecture role: Repository / External layer. No orchestrator logic here —
 * just tool handlers behind a thin in-process adapter.
 */

import { LocalMcp, type LocalTool } from "../mcp/local-mcp.js";
import { createExcelTools } from "./excel-tools/excel-tools.js";
import type { ToolContext } from "./types.js";

/** The MCP server name this module mounts under (tools namespace as `excel__*`). */
export const EXCEL_SERVER_NAME = "excel";

/**
 * Build an Excel `LocalMcp` for a specific turn's context.
 *
 * Each Excel tool is already a `{ descriptor, callTool(args, ctx) }`; we bind
 * the turn's `ToolContext` into a `LocalTool.invoke(args)` so the server matches
 * the `Mcp` contract. Excel handlers return a string `content` already, so the
 * result passes through unchanged (its optional post-call `event` is dropped —
 * the orchestrator no longer routes Excel through the synthetic event path).
 */
export function createExcelLocalMcp(toolCtx: ToolContext): LocalMcp {
  const tools: LocalTool[] = createExcelTools().map((tool) => ({
    descriptor: tool.descriptor,
    invoke: async (args) => {
      const result = await tool.callTool(args ?? {}, toolCtx);
      return { isError: result.isError, content: result.content };
    },
  }));

  return new LocalMcp(EXCEL_SERVER_NAME, tools);
}
