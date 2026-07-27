import type { ToolExecutionResult } from "@agent-local/mcp";
import { OrchestratorEventTypes } from "../runner-events.js";
import type { RunnerContext } from "../middleware/runner-middleware.js";
import type { Turn } from "../turn.js";
import type { ContextContributor } from "./types.js";

// recalls this session's relevant memories and injects them as transient context.
// memomcp lives in the registry but in no role whitelist, so it is reachable here yet never a callable tool.
// no-ops when unmounted and fails open so recall never blocks the turn
export class MemoryContributor implements ContextContributor {
  readonly name = "memory";

  async contribute(turn: Turn, ctx: RunnerContext): Promise<void> {
    const memory = ctx.runtime.getMcpClientRegistry().getClient("memomcp");
    if (!memory) return;

    const events = ctx.events;
    events.publish(OrchestratorEventTypes.RECALL_START, {});

    let result: ToolExecutionResult;
    try {
      result = await memory.callTool("recall", { query: turn.turnRequest! }, ctx.signal);
    } catch (err) {
      events.publish(OrchestratorEventTypes.WARNING, {
        message: `memory recall failed: ${(err as Error).message}`,
      });
      return;
    }

    if (result.isError || result.content.trim().length === 0) return;

    turn.injectTransient({
      role: "system",
      content: `Relevant memories recalled for this request (use if helpful):\n\n${result.content}`,
    });

    events.publish(OrchestratorEventTypes.RECALL_FINALIZE, { chars: result.content.length });
  }
}
