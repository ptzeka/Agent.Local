import type { Principal } from "./identity/types.js";
import type { ChatMessage } from "./providers/provider.js";

/**
 * Session — the unit of conversational state.
 *
 * Was previously the implicit `Orchestrator.conversation` field. Lifting it
 * into a standalone value lets a single (stateless) orchestrator run turns
 * for many independent sessions, and lets the Initializer own, persist, and
 * resume them by `sessionId`.
 *
 * `workspaceId` is deliberately separate from `sessionId`: several sessions
 * working toward a common goal can share one workspace (and therefore one
 * project context), while still keeping independent transcripts.
 */

export type SessionStatus =
  | "idle" // created, never run
  | "running" // a turn is in flight (guards against overlapping dispatches)
  | "awaiting-input" // last turn completed, ready for the next user message
  | "done" // terminal — no further turns expected
  | "error"; // last turn threw; transcript may be partial

export interface SessionCounters {
  /** Completed user turns. */
  turns: number;

  /**
   * Cumulative model token usage for this session, summed across every
   * orchestrator chat call. A running tally for cost/cache visibility — not a
   * per-turn figure. (Executor and evaluator usage are not yet folded in.)
   * Fields may be absent on sessions persisted before this was added; read
   * them through `?? 0`.
   */
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface Session {
  sessionId: string;
  workspaceId: string;
  /** Reserved for sub-sessions; unused until the background-agent work lands. */
  parentSessionId?: string;
  conversation: ChatMessage[];
  status: SessionStatus;
  counters: SessionCounters;
  /** Epoch millis. */
  createdAt: number;
  /** Epoch millis; bumped on every persist. */
  updatedAt: number;
  /**
   * Identity of the caller that opened this session. Always set on in-memory
   * sessions (anonymous when no credentials were presented). May be absent on
   * sessions persisted before identity was added — treat as anonymous.
   */
  user?: Principal;
}

export interface CreateSessionParams {
  sessionId: string;
  workspaceId: string;
  parentSessionId?: string;
}

/**
 * Build a fresh session in the `idle` state. Pure: persistence and id
 * minting are the Initializer's job, so this never touches disk or randomness.
 */
export function createSession(params: CreateSessionParams): Session {
  const now = Date.now();
  return {
    sessionId: params.sessionId,
    workspaceId: params.workspaceId,
    parentSessionId: params.parentSessionId,
    conversation: [],
    status: "idle",
    counters: {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
}
