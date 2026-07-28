import type { ChatMessage } from "../../providers/provider.js";
import type { RunnerContext } from "../middleware/runner-middleware.js";
import type { Turn } from "../turn.js";
import type { TurnProfile } from "../turn-profile.js";
import type { CompletionPolicy, CompletionVerdict } from "./types.js";

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

// the role's `completion` contract name picks the policy; adding a contract is a new case here,
// never an `if` on a role name. evaluation is not a gate — it runs as a terminal pass (see evaluator-pass)
export function selectCompletionPolicy(profile: TurnProfile): CompletionPolicy {
  switch (profile.completion) {
    case "tool-evidence":
      return new ToolEvidenceCompletion();
    case "structured-verdict":
      return new ReportRequiredCompletion();
    case "self-terminate":
      return new AcceptFirstReplyCompletion();
    default:
      throw new Error(`Unknown completion contract "${profile.completion}".`);
  }
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
