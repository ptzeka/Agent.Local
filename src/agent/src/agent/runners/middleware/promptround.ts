import { OrchestratorEventTypes } from "../runner-events.js";
import { Round, type RoundOutcome } from "./iround.js";
import type { Turn } from "./turn.js";

// pulls exactly ONE queued prompt, on the turn's first iteration, as this turn's request; that
// request then carries across iterations, so a prompt queued mid-turn is left for the next turn.
// a cold wake with nothing queued settles without ever calling the model
export class PromptRound extends Round {
  async runAsync(turn: Turn): Promise<RoundOutcome> {
    // pull once: turnRequest===null marks the first iteration. a later iteration with an empty
    // inbox is agentic continuation, and one with a queued prompt must not fold it into this turn
    if (turn.turnRequest === null && this.context.hasPending?.()) {
      const injectedPrompt = this.context.pullInjectedPrompt?.() ?? "";
      turn.append({ role: "user", content: injectedPrompt });
      this.context.events.publish(OrchestratorEventTypes.INJECTED_INPUT, {
        turnId: turn.id,
        content: injectedPrompt,
      });
      turn.turnRequest = injectedPrompt;
    }

    this.context.logger.debug("turn input drained", {
      turnId: turn.id,
      hasRequest: turn.turnRequest !== null,
    });

    // cold empty wake: nothing queued and no request ever landed, so end without a model call.
    // once turnRequest is set it persists across iterations, so this fires only on the first pass
    if (turn.turnRequest === null) {
      this.context.logger.debug("empty turn — no queued input, settling without model call", {
        sessionId: this.context.session.sessionId,
      });
      // iterations 0, not turn.iteration: nothing ran, and headless accounting must see that
      return {
        kind: "done",
        result: {
          finalMessage: { role: "assistant", content: "" },
          iterations: 0,
          dispatches: turn.tracker.count,
          outcome: "satisfied",
        },
      };
    }

    return { kind: "continue" };
  }
}
