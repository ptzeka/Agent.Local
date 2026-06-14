// re-registered each turn with that turn's ToolContext baked in; calls route to the SessionManager, never a transport

import { LocalMcp, type LocalTool } from "../mcp/local-mcp.js";
import { createSubSessionTools } from "./subsessions-tools/subsessions.js";
import type { ToolContext } from "./types.js";

export const SUBSESSIONS_SERVER_NAME = "subsessions";

// when the turn's coordinator is absent the tools still advertise but each call returns the handlers' "not available" error
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
