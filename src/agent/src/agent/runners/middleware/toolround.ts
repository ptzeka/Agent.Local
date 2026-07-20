import type { ToolExecutionResult } from "@agent-local/mcp";
import type { ChatMessage, ToolCall } from "../../providers/provider.js";
import { Round, type RoundOutcome } from "./iround.js";
import type { Turn } from "./turn.js";

// executes the iteration's tool calls, ends the turn on a landed report_result,
// and runs the mid-flight progress gate before persisting the round
export class ToolRound extends Round {
  async runAsync(turn: Turn): Promise<RoundOutcome> {
    const toolMessages: ChatMessage[] = [];

    for (const call of turn.toolCalls) {
      if (this.context.signal?.aborted) {
        throw new Error("turn aborted: user requested stop");
      }

      this.context.logger.debug("tool call start", { name: call.name });
      turn.toolCallsMade += 1;
      const execution: ToolExecutionResult = await turn.scopedClients.callTool(
        call.name,
        call.arguments,
        this.context.events,
        this.context.signal
      );
      this.context.logger.debug("tool call end", { name: call.name, isError: execution.isError });
      // delegated cost rides the tool-result event (published by the scoped client) into the MetricsRegistry,
      // so the loop no longer folds it here; it stays separable as the registry's *Tallied figures
      toolMessages.push(
        wrapToolResult(call, execution.isError ? `[tool-error] ${execution.content}` : execution.content)
      );
    }

    turn.append(...toolMessages);

    // report_result is the mandated terminal action on a dispatched turn: once it lands, end the turn with the
    // structured verdict — its status drives the outcome, so a "fail" verdict fails the step even though the
    // agent answered honestly (the M5-9 gap: a true-but-negative answer must not bank as satisfied).
    const reported = turn.resultSink.value;
    if (reported) {
      return turn.finalizeReported(reported);
    }
    
    // persist this round so a crash mid-turn loses at most the round in flight
    await turn.flush();
    return { kind: "continue" };
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
