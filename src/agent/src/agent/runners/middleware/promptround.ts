import type { ChatMessage } from "../../providers/provider.js";
import { OrchestratorEventTypes } from "../runner-events.js";
import { Round, type RoundOutcome } from "./iround.js";
import type { Turn } from "./turn.js";

// drains the inbox into the turn: the first non-empty drain becomes this turn's request,
// and a wake with nothing queued settles without ever calling the model
export class PromptRound extends Round {
  async runAsync(turn: Turn): Promise<RoundOutcome> {
    const injectedPrompt = this.context.pullInjectedPrompt?.() ?? "";
      const injected: ChatMessage = { role: "user", content: injectedPrompt };
      turn.append(injected);
      this.context.events.publish(OrchestratorEventTypes.INJECTED_INPUT, {
        iteration: turn.iteration,
        content: injectedPrompt,
      });
    
    if (turn.turnRequest === null && injectedPrompt) {
      turn.turnRequest = injectedPrompt;
    }

    this.context.logger.debug("turn input drained", {
      iteration: turn.iteration,
      drained: injectedPrompt ? 1 : 0,
      hasRequest: turn.turnRequest !== null,
    });

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
