/**
 * In-process subsessions MCP server.
 *
 * Like the Excel server, subsessions tools need per-turn context: the session's
 * coordinator, workspace, etc. The orchestrator re-registers this LocalMcp each
 * turn with that turn's `ToolContext` baked into the tool handlers; calls route
 * to the SessionManager (the SubSessionCoordinator) — never through a transport.
 * Tool names are namespaced as `subsessions__*` (e.g. `subsessions__create_subsession`).
 *
 * Architecture role: Repository / External layer. No orchestrator logic here —
 * just tool handlers behind the `Mcp` contract.
 */

import { LocalMcp, type LocalTool } from "../mcp/local-mcp.js";
import { createSubSessionTools } from "./subsessions-tools/subsessions.js";
import type { ToolContext } from "./types.js";

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
