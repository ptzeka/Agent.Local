import type { ChatMessage } from "../../providers/provider.js";
import { Evaluator, type EvaluationVerdict } from "../evaluator.js";
import { OrchestratorEventTypes } from "../runner-events.js";
import type { RunnerContext } from "../middleware/runner-middleware.js";
import type { Turn } from "../turn.js";
import type { TurnProfile } from "../turn-profile.js";
import type { CompletionPolicy, CompletionVerdict } from "./types.js";

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

// the profile picks the gate; adding a turn kind means adding a policy here, never an `if` in the loop
export function selectCompletionPolicy(profile: TurnProfile): CompletionPolicy {
  if (profile.terminatesOnToolFreeReply) return new ToolEvidenceCompletion();
  if (profile.structuredMode) return new ReportRequiredCompletion();
  if (profile.evaluatorGated) return new EvaluatorCompletion();
  return new AcceptFirstReplyCompletion();
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

// executor semantics: the first tool-free reply IS the result, gated only on tool evidence
export class ToolEvidenceCompletion implements CompletionPolicy {
  async judge(turn: Turn, reply: ChatMessage, _ctx: RunnerContext): Promise<CompletionVerdict> {
    // a tool-free executor that NEVER called a tool only narrated; the mutation never ran. Fail the
    // dispatch so the parent sees ok=false and cannot bank the no-op (covers the fabricated-report case).
    if (turn.toolCallsMade === 0) {
      return {
        kind: "fail",
        reason: `executor produced no tool call — no action was taken. Reported: ${reply.content.slice(0, 200)}`,
      };
    }
    return { kind: "settle", outcome: "satisfied" };
  }
}

// structured mode: a prose answer that skipped report_result has no parseable verdict, so it must not
// settle as satisfied. Nudge for the mandated call and keep going; if the model never complies the cap
// trips, which the dispatch boundary maps to a fail envelope (fails closed).
export class ReportRequiredCompletion implements CompletionPolicy {
  async judge(turn: Turn, _reply: ChatMessage, _ctx: RunnerContext): Promise<CompletionVerdict> {
    return {
      kind: "continue",
      nudge:
        `You answered without calling report_result. You MUST finish by calling report_result ` +
        `with the final status ("success"/"fail") and a structured result. ` +
        `The request for THIS turn is exactly: «${turn.turnRequest}»`,
    };
  }
}

// capable models self-verify, so the first tool-free answer settles on their own word
export class AcceptFirstReplyCompletion implements CompletionPolicy {
  async judge(_turn: Turn, _reply: ChatMessage, _ctx: RunnerContext): Promise<CompletionVerdict> {
    return { kind: "settle", outcome: "satisfied" };
  }
}

// judged gate for weaker models: scores the proposed answer against this turn's own transcript
export class EvaluatorCompletion implements CompletionPolicy {
  async judge(turn: Turn, reply: ChatMessage, ctx: RunnerContext): Promise<CompletionVerdict> {
    const verdict = await this.evaluate(turn, reply.content, ctx);

    // awaiting-input did no work — keep it distinct so headless exits non-zero instead of reporting success
    if (verdict.state === "satisfied" || verdict.state === "awaiting-input") {
      return { kind: "settle", outcome: verdict.state === "awaiting-input" ? "awaiting-input" : "satisfied" };
    }

    // terminal: stop trying rather than nudge-and-loop until the cap
    if (verdict.state === "failed") return { kind: "fail", reason: verdict.reason };

    // Nudges quote the request verbatim to prevent goal drift.
    return {
      kind: "continue",
      nudge:
        verdict.state === "continue"
          ? `EVALUATOR: on track — ${verdict.reason}\n` +
            `The request for THIS turn is exactly: «${turn.turnRequest}»\n` +
            "Keep going: take the next concrete action toward fulfilling it. " +
            "Do not stop until it is complete."
          : `EVALUATOR: off track — ${verdict.reason}\n` +
            `The request for THIS turn is exactly: «${turn.turnRequest}»\n` +
            "Stop repeating what isn't working and change your approach. Re-check this " +
            "request and the current workspace state, then take a different next action.",
    };
  }

  private async evaluate(
    turn: Turn,
    proposedAnswer: string,
    ctx: RunnerContext
  ): Promise<EvaluationVerdict> {
    const events = ctx.events;
    events.publish(OrchestratorEventTypes.EVALUATION_START, {});

    try {
      const evaluator = new Evaluator(ctx.runtime);
      const verdict = await evaluator.evaluate(
        {
          question: turn.turnRequest!,
          proposedAnswer,
          transcript: turn.transcriptOfTurn(),
        },
        { signal: ctx.signal, temperature: turn.config.orchestration.evaluatorTemperature }
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
