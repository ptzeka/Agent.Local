// registered once with the runtime's coordinator wired in; calls route to the SessionManager, never a transport
// the turn's signal is not baked — bindToolContext threads each call's cutoffscope in as ctx.signal

import { LocalMcp } from "@agent-local/mcp";
import { createSubSessionTools } from "./subsessions-tools/subsessions.js";
import { bindToolContext, type ToolContext } from "./types.js";

export const SUBSESSIONS_SERVER_NAME = "subsessions";

// when the coordinator is absent the tools still advertise but each call returns the handlers' "not available" error
export function createSubsessionsLocalMcp(toolCtx: ToolContext): LocalMcp {
  return new LocalMcp(SUBSESSIONS_SERVER_NAME, bindToolContext(createSubSessionTools(), toolCtx));
}
