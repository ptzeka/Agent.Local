import type { Principal } from "../identity/types.js";

/**
 * Session — the unit of run state (status, counters, identity, links).
 *
 * The transcript itself lives in a separate `Conversation` (rolling JSONL
 * file), linked by `conversationId`: appending a message is then an O(1) file
 * append instead of a full session rewrite, and the session file stays small
 * metadata. ConversationMiddleware follows the link at init.
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
   * Cumulative model token usage for THIS session's own chat calls only —
   * delegated work (executor dispatches, sub-sessions) is kept apart in the
   * `*Tallied` fields below so the two figures can't be confused. A running
   * tally for cost/cache visibility — not a per-turn figure. Fields may be
   * absent on sessions persisted before this was added; read them through
   * `?? 0`.
   */
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;

  /**
   * Cumulative token usage of dependencies — child runs whose cost this
   * session caused but did not spend itself: executor dispatches (reported on
   * the tool result) and settled sub-sessions (folded by the SessionManager).
   * Each fold adds the child's TOTAL (its own usage plus its own tallied
   * dependencies), so a parent's tallied figure covers the whole tree below
   * it. Session total cost = own fields + these.
   */
  inputTokensTallied: number;
  outputTokensTallied: number;
  cacheReadInputTokensTallied: number;
  cacheCreationInputTokensTallied: number;
}

/**
 * A token-usage tally as exposed by a producer (a chat response, a tool
 * result carrying a child run's cost). All fields optional so providers and
 * tools that can't report a figure simply omit it. The `*Tallied` fields are
 * present when the producer is itself a session that had dependencies.
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  inputTokensTallied?: number;
  outputTokensTallied?: number;
  cacheReadInputTokensTallied?: number;
  cacheCreationInputTokensTallied?: number;
}

/**
 * Fold a chat response's usage into the session's OWN counters. Only for
 * tokens this session's loop spent directly — delegated cost goes through
 * `foldDelegatedUsage` instead.
 */
export function foldCounters(into: SessionCounters, usage: TokenUsage | undefined): void {
  if (!usage) return;
  into.inputTokens = (into.inputTokens ?? 0) + (usage.inputTokens ?? 0);
  into.outputTokens = (into.outputTokens ?? 0) + (usage.outputTokens ?? 0);
  into.cacheReadInputTokens =
    (into.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
  into.cacheCreationInputTokens =
    (into.cacheCreationInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
}

/**
 * Fold a dependency's usage into the session's `*Tallied` counters. Adds the
 * dependency's own usage AND its tallied dependencies, so the receiving
 * session's tallied figure is the full cost of the tree it delegated.
 */
export function foldDelegatedUsage(into: SessionCounters, usage: TokenUsage | undefined): void {
  if (!usage) return;
  into.inputTokensTallied =
    (into.inputTokensTallied ?? 0) + (usage.inputTokens ?? 0) + (usage.inputTokensTallied ?? 0);
  into.outputTokensTallied =
    (into.outputTokensTallied ?? 0) + (usage.outputTokens ?? 0) + (usage.outputTokensTallied ?? 0);
  into.cacheReadInputTokensTallied =
    (into.cacheReadInputTokensTallied ?? 0) +
    (usage.cacheReadInputTokens ?? 0) +
    (usage.cacheReadInputTokensTallied ?? 0);
  into.cacheCreationInputTokensTallied =
    (into.cacheCreationInputTokensTallied ?? 0) +
    (usage.cacheCreationInputTokens ?? 0) +
    (usage.cacheCreationInputTokensTallied ?? 0);
}

export interface Session {
  sessionId: string;
  workspaceId: string;
  /** Reserved for sub-sessions; unused until the background-agent work lands. */
  parentSessionId?: string;
  /**
   * Link to this session's transcript (a rolling JSONL file owned by the
   * ConversationStore). Stamped at creation; sessions persisted before the
   * conversation split lack it and get a fresh one minted on resume.
   */
  conversationId: string;
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
  /**
   * Content-addressed context snapshots by role name (e.g., "orchestrator", "executor").
   * Each maps to a hash pointing to `<contextsDir>/<hash>.json` recording the
   * system prompt + project direction + tool block that role ran on.
   * Stamped by ContextMiddleware at init for each role. Absent on sessions
   * persisted before context snapshots were added.
   */
  contextHashes?: Record<string, string>;
}

export interface CreateSessionParams {
  sessionId: string;
  workspaceId: string;
  conversationId: string;
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
    conversationId: params.conversationId,
    parentSessionId: params.parentSessionId,
    status: "idle",
    counters: {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      inputTokensTallied: 0,
      outputTokensTallied: 0,
      cacheReadInputTokensTallied: 0,
      cacheCreationInputTokensTallied: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
}
