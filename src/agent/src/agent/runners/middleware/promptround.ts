import { OrchestratorEventTypes } from "../runner-events.js";
import { Round, type RoundOutcome } from "./iround.js";
import type { Turn } from "./turn.js";

// pulls one queued prompt per iteration: the first non-empty pull becomes this turn's request,
// and a cold wake with nothing queued settles without ever calling the model
export class PromptRound extends Round {
  async runAsync(turn: Turn): Promise<RoundOutcome> {
    // only pull when input is actually queued: a later iteration with an empty inbox is agentic
    // continuation of the in-flight request, not a new prompt, so it must not append an empty turn
    if (this.context.hasPending?.()) {
      const injectedPrompt = this.context.pullInjectedPrompt?.() ?? "";
      turn.append({ role: "user", content: injectedPrompt });
      this.context.events.publish(OrchestratorEventTypes.INJECTED_INPUT, {
        turnId: turn.id,
        content: injectedPrompt,
      });
      if (turn.turnRequest === null) {
        turn.turnRequest = injectedPrompt;
      }
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
