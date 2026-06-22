// re-registered each dispatched turn with that turn's ToolContext (carrying the live result sink) baked in,
// mirroring the subsessions server: calls route in-process to the sink, never a transport

import { LocalMcp, type LocalTool } from "@agent-local/mcp";
import { createReportResultTools } from "./turn-result-tools.js";
import type { ToolContext } from "./types.js";

export const TURN_RESULT_SERVER_NAME = "turnresult";

// mounted only on dispatched turns (gated by the structuredResult flag); when no sink is bound the handler
// returns its "not available" error rather than silently dropping the verdict
export function createTurnResultLocalMcp(toolCtx: ToolContext): LocalMcp {
  const tools: LocalTool[] = createReportResultTools().map((tool) => ({
    descriptor: tool.descriptor,
    invoke: async (args) => {
      const result = await tool.callTool(args ?? {}, toolCtx);
      return { isError: result.isError, content: result.content };
    },
  }));

  return new LocalMcp(TURN_RESULT_SERVER_NAME, tools);
}
