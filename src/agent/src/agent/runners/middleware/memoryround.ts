import type { ToolExecutionResult } from "@agent-local/mcp";
import { OrchestratorEventTypes } from "../runner-events.js";
import { Round, type RoundOutcome } from "./iround.js";
import type { Turn } from "./turn.js";

// turn-start memory recall: fetches this session's relevant memories and injects them as context.
// memomcp lives in the registry but in no role whitelist, so it is reachable here yet never a callable tool.
// runs once per turn keyed on the first real request; no-ops when unmounted and fails open so recall never blocks
export class MemoryRound extends Round {
  async runAsync(turn: Turn): Promise<RoundOutcome> {
    if (turn.recalled) return { kind: "continue" };
    turn.recalled = true;

    const memory = this.context.runtime.getMcpClientRegistry().getClient("memomcp");
    if (!memory) return { kind: "continue" };

    const events = this.context.events;
    events.publish(OrchestratorEventTypes.RECALL_START, {});

    let result: ToolExecutionResult;
    try {
      result = await memory.callTool("recall", { query: turn.turnRequest! }, this.context.signal);
    } catch (err) {
      events.publish(OrchestratorEventTypes.WARNING, {
        message: `memory recall failed: ${(err as Error).message}`,
      });
      return { kind: "continue" };
    }

    if (result.isError || result.content.trim().length === 0) return { kind: "continue" };

    turn.injectTransient({
      role: "system",
      content: `Relevant memories recalled for this request (use if helpful):\n\n${result.content}`,
    });

    events.publish(OrchestratorEventTypes.RECALL_FINALIZE, { chars: result.content.length });
    return { kind: "continue" };
  }
}
