import type { RunResult } from "../orchestrator.js";
import { Evaluator, type EvaluationVerdict } from "../evaluator.js";
import { OrchestratorEventTypes } from "../runner-events.js";
import type { RunnerContext } from "./runner-middleware.js";
import type { Turn } from "./turn.js";

// what a round tells the loop: keep descending, restart the iteration, or end the turn with a result
export type RoundOutcome =
  | { kind: "continue" }
  | { kind: "next-iteration" }
  | { kind: "done"; result: RunResult };

// one step of an iteration; the Turn runs its list in order and obeys the returned outcome
export interface IRound {
  runAsync(turn: Turn): Promise<RoundOutcome>;
}

// base for all rounds: holds the RunnerContext plus the evaluator gate shared by
// more than one round; turn mutations go through the Turn itself
export abstract class Round implements IRound {
  protected readonly context: RunnerContext;

  constructor(ctx: RunnerContext) {
    this.context = ctx;
  }

  abstract runAsync(turn: Turn): Promise<RoundOutcome>;

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
