import type { RunResult } from "../orchestrator.js";
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

}
