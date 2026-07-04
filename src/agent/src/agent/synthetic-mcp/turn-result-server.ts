// mounted only when a role whitelists it (the workflow-orchestrator role); when no sink is bound the handler
// returns its "not available" error rather than silently dropping the verdict

import { LocalMcp } from "@agent-local/mcp";
import { createReportResultTools } from "./turn-result-tools.js";
import type { ToolContext, TurnBindable, TurnBinding, TurnResultSink } from "./types.js";

export const TURN_RESULT_SERVER_NAME = "turnresult";

// registered once; the verdict sink is the only per-turn state, swapped in via bindTurn each dispatched turn
// so a previous turn's report can never leak into this turn's outcome
export class TurnResultLocalMcp extends LocalMcp implements TurnBindable {
  private resultSink?: TurnResultSink;

  constructor(baseCtx: ToolContext) {
    // handlers close over `this` for the live sink, so tools register after super()
    super(TURN_RESULT_SERVER_NAME, []);
    for (const tool of createReportResultTools()) {
      this.registerTool({
        descriptor: tool.descriptor,
        invoke: async (args, cutoffscope) => {
          const result = await tool.callTool(args ?? {}, {
            ...baseCtx,
            signal: cutoffscope.signal,
            resultSink: this.resultSink,
          });
          return { isError: result.isError, content: result.content };
        },
      });
    }
  }

  public bindTurn(binding: TurnBinding): void {
    this.resultSink = binding.resultSink;
  }
}
