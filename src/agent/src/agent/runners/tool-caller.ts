import type { ToolExecutionResult } from "@agent-local/mcp";
import type { ChatMessage, ToolCall } from "../providers/provider.js";
import type { ReportedTurnResult } from "../synthetic-mcp/types.js";
import type { RunnerContext } from "./middleware/runner-middleware.js";
import type { Turn } from "./turn.js";

// executes an iteration's tool calls and pairs the results into the transcript.
// part of the loop itself, not an extension point: it reports what landed and decides nothing
export class ToolCaller {
  // returns the landed report_result when the mandated terminal call fired; the loop decides what that means
  async run(turn: Turn, ctx: RunnerContext, calls: ToolCall[]): Promise<ReportedTurnResult | null> {
    const toolMessages: ChatMessage[] = [];

    for (const call of calls) {
      if (ctx.signal?.aborted) {
        throw new Error("turn aborted: user requested stop");
      }

      ctx.logger.debug("tool call start", { name: call.name });
      turn.toolCallsMade += 1;
      const execution: ToolExecutionResult = await turn.scopedClients.callTool(
        call.name,
        call.arguments,
        ctx.events,
        ctx.signal
      );
      ctx.logger.debug("tool call end", { name: call.name, isError: execution.isError });
      // delegated cost rides the tool-result event (published by the scoped client) into the MetricsRegistry,
      // so the loop no longer folds it here; it stays separable as the registry's *Tallied figures
      toolMessages.push(
        wrapToolResult(call, execution.isError ? `[tool-error] ${execution.content}` : execution.content)
      );
    }

    turn.append(...toolMessages);

    // the reporting path flushes with its own envelope, so only the continuing path persists here
    const reported = turn.resultSink.value;
    if (reported) return reported;

    // persist this round so a crash mid-turn loses at most the round in flight
    await turn.flush();
    return null;
  }
}

// pure mapper: a tool execution into the transcript's tool message shape
function wrapToolResult(call: ToolCall, content: string): ChatMessage {
  return {
    role: "tool",
    content,
    toolCallId: call.id,
    toolName: call.name,
  };
}
