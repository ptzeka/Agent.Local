import { Round, type RoundOutcome } from "./iround.js";
import type { Turn } from "./turn.js";

// decides what a tool-free reply means per role: the executor's evidence-gated result,
// the structured-mode report_result nudge, or the orchestrator's evaluator gate
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

    // Orchestrator: gate through the evaluator, unless config disables it — capable models self-verify, so the
    // first tool-free answer settles as satisfied on their own word (the guard rail is for weaker models).
    if (!turn.config.orchestration.evaluatorEnabled) {
      return turn.settle(assistantMessage, "satisfied");
    }

    const verdict = await this.evaluateCompletion(turn, assistantMessage.content);

    if (verdict.state === "satisfied" || verdict.state === "awaiting-input") {
      // awaiting-input did no work — keep it distinct so headless exits non-zero instead of reporting success
      return turn.settle(
        assistantMessage,
        verdict.state === "awaiting-input" ? "awaiting-input" : "satisfied"
      );
    }

    // terminal: stop trying rather than nudge-and-loop until the cap
    if (verdict.state === "failed") {
      return turn.fail(verdict.reason);
    }

    // Nudges quote the request verbatim to prevent goal drift.
    await turn.nudge(
      verdict.state === "continue"
        ? `EVALUATOR: on track — ${verdict.reason}\n` +
            `The request for THIS turn is exactly: «${turn.turnRequest}»\n` +
            "Keep going: take the next concrete action toward fulfilling it. " +
            "Do not stop until it is complete."
        : `EVALUATOR: off track — ${verdict.reason}\n` +
            `The request for THIS turn is exactly: «${turn.turnRequest}»\n` +
            "Stop repeating what isn't working and change your approach. Re-check this " +
            "request and the current workspace state, then take a different next action."
    );
    return { kind: "next-iteration" };
  }
}
