import { EvaluationVerdict, Evaluator } from "../evaluator.js";
import { OrchestratorEventTypes } from "../runner-events.js";
import { Round, type RoundOutcome } from "./iround.js";
import type { Turn } from "./turn.js";

// completion gate for the orchestrator's tool-free reply: judges the proposed answer against
// this turn's own transcript, scoped from its anchor (turnStartIndex) so prior turns are excluded
export class EvaluatorRound extends Round {
  async runAsync(turn: Turn): Promise<RoundOutcome> {
    // ResponseRound already settled/nudged every other case (tool calls, executor, structured
    // mode); reaching here with tool calls just means this round is passing through to ToolRound
    if (turn.toolCalls.length > 0) return { kind: "continue" };

    const assistantMessage = turn.assistantMessage!;

    // capable models self-verify, so the first tool-free answer settles as satisfied on their
    // own word when config disables the gate (the guard rail is for weaker models)
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

    protected async evaluateCompletion(turn: Turn, proposedAnswer: string): Promise<EvaluationVerdict> {
    const events = this.context.events;
    events.publish(OrchestratorEventTypes.EVALUATION_START, {});

    try {
      const evaluator = new Evaluator(this.context.runtime);
      const verdict = await evaluator.evaluate(
        {
          question: turn.turnRequest!,
          proposedAnswer,
          transcript: turn.transcriptOfTurn(),
        },
        { signal: this.context.signal, temperature: turn.config.orchestration.evaluatorTemperature }
      );
      if (verdict?.reason) {
        events.publish(OrchestratorEventTypes.EVALUATION_VERDICT, {
          state: verdict.state,
          reason: verdict.reason,
        });
      }
      return verdict;
    } catch (err) {
      // fail open: never trap the user because the judge errored
      events.publish(OrchestratorEventTypes.WARNING, {
        message: `evaluation failed, treating as satisfied: ${(err as Error).message}`,
      });
      return { state: "satisfied", reason: "evaluator error; defaulting to satisfied" };
    }
  }
}
