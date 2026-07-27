import type { ChatMessage } from "../../providers/provider.js";
import type { RunnerContext } from "../middleware/runner-middleware.js";
import type { Turn } from "../turn.js";

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

// what a completion policy decides about a tool-free reply; the loop applies it, the policy never does
export type CompletionVerdict =
  | { kind: "settle"; outcome: "satisfied" | "awaiting-input" }
  | { kind: "fail"; reason: string }
  | { kind: "continue"; nudge: string };

// ---------------------------------------------------------------------------
// Extension slots
// ---------------------------------------------------------------------------

// builds the standing system/context prefix once per turn; exactly one per runtime
export interface ContextProvider {
  build(turn: Turn, ctx: RunnerContext): Promise<ChatMessage[]>;
}

// decides AND performs history compaction at turn start; exactly one per runtime
export interface CompactionPolicy {
  applyIfNeeded(turn: Turn, ctx: RunnerContext): Promise<void>;
}

// additive only — may inject context, can never end a turn, so any number may register safely
export interface ContextContributor {
  readonly name: string;
  contribute(turn: Turn, ctx: RunnerContext): Promise<void>;
}

// the ONLY decider of turn termination; exactly one per turn, chosen from the profile
export interface CompletionPolicy {
  judge(turn: Turn, reply: ChatMessage, ctx: RunnerContext): Promise<CompletionVerdict>;
}
