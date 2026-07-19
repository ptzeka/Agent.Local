import { Round, type RoundOutcome } from "./iround.js";
import type { Turn } from "./turn.js";

// decides what a tool-free reply means per role: the executor's evidence-gated result,
// the structured-mode report_result nudge, or handing the orchestrator's tool-free
// reply down to EvaluatorRound
export class ResponseRound extends Round {
  async runAsync(turn: Turn): Promise<RoundOutcome> {
    if (turn.toolCalls.length > 0) return { kind: "continue" };

    const assistantMessage = turn.assistantMessage!;

    // Executor: first tool-free response is the RESULT — no evaluator gate.
    if (turn.role === "executor") {
      // a tool-free executor that NEVER called a tool only narrated; the mutation never ran. Fail the
      // dispatch so the parent sees ok=false and cannot bank the no-op (covers the fabricated-report case).
      if (turn.toolCallsMade === 0) {
        return turn.fail(
          `executor produced no tool call — no action was taken. Reported: ${assistantMessage.content.slice(0, 200)}`
        );
      }
      return turn.settle(assistantMessage, "satisfied");
    }

    // Structured mode: a prose answer that skipped report_result has no parseable verdict, so it must not
    // settle as satisfied (that reopens the M5-9 gap). Nudge for the mandated call and keep going; if the
    // model never complies the cap trips, which the dispatch boundary maps to a fail envelope (fails closed).
    if (turn.structuredMode) {
      await turn.nudge(
        `You answered without calling report_result. You MUST finish by calling report_result ` +
          `with the final status ("success"/"fail") and a structured result. ` +
          `The request for THIS turn is exactly: «${turn.turnRequest}»`
      );
      return { kind: "next-iteration" };
    }

    // Orchestrator, tool-free, non-structured: EvaluatorRound (below) owns the completion gate.
    return { kind: "continue" };
  }
}
