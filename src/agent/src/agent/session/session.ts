import type { TokenUsage } from "@agent-local/common/tokenusage";
import type { Principal } from "../identity/types.js";

// run-state metadata only; the transcript lives in a linked Conversation so appends stay O(1) and this file small
// workspaceId is separate from sessionId so several sessions toward a common goal share one workspace + context
export type SessionStatus =
  | "idle" // created, never run
  | "running" // a turn is in flight (guards against overlapping dispatches)
  | "awaiting-input" // last turn completed, ready for the next user message
  | "done" // terminal — no further turns expected
  | "error"; // last turn threw; transcript may be partial

// the token tally shared by a session's counters and the container-owned MetricsRegistry; split so
// own spend (direct chat) never blurs with *Tallied delegated subtree spend, and either can hold it
export interface UsageTotals {
  // THIS owner's own chat spend only; delegated work is kept in the *Tallied fields so the two can't be confused
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;

  // dependency cost this owner caused but didn't spend; each fold adds the child's TOTAL, so this covers the whole subtree
  inputTokensTallied: number;
  outputTokensTallied: number;
  cacheReadInputTokensTallied: number;
  cacheCreationInputTokensTallied: number;
}

export function newUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    inputTokensTallied: 0,
    outputTokensTallied: 0,
    cacheReadInputTokensTallied: 0,
    cacheCreationInputTokensTallied: 0,
  };
}

// token spend left the session: it now lives in the container-owned MetricsRegistry, persisted to the
// metrics JSONL keyed by sessionId; only the turn count remains run-state metadata on the session
export interface SessionCounters {
  turns: number;
}

// only for tokens this owner's loop spent directly; delegated cost goes through foldDelegatedUsage
export function foldCounters(into: UsageTotals, usage: TokenUsage | undefined): void {
  if (!usage) return;
  into.inputTokens = (into.inputTokens ?? 0) + (usage.inputTokens ?? 0);
  into.outputTokens = (into.outputTokens ?? 0) + (usage.outputTokens ?? 0);
  into.cacheReadInputTokens =
    (into.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
  into.cacheCreationInputTokens =
    (into.cacheCreationInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
}

// adds the dependency's own usage AND its tallied dependencies, so the figure is the full delegated tree cost
export function foldDelegatedUsage(into: UsageTotals, usage: TokenUsage | undefined): void {
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
  parentSessionId?: string;
  // link to the rolling transcript; a pre-split session lacks it and gets a fresh one minted on resume
  conversationId: string;
  memoryCollectionId?: string;
  status: SessionStatus;
  counters: SessionCounters;
  createdAt: number;
  updatedAt: number;
  // absent on pre-identity sessions; treat that as anonymous
  user?: Principal;
  // per-role hash into <contextsDir>/<hash>.json, recording what each role ran on; stamped by ContextMiddleware
  contextHashes?: Record<string, string>;
  // opaque caller-owned reference (the host passes its workId at /session/create), set once at creation so the
  // agent can be traced back to the external unit that opened it without a host round-trip. Never rewritten.
  externalReferenceKey?: string;
}

// the memomcp collection (store namespace) a session reads and writes — the unit of memory segregation.
// while anonymous the collection is the session's own id (a random uuid, so memory never crosses sessions);
// once a Principal is authenticated it becomes that subject's id, so the same user's memory follows them.
// later this is where a dedicated per-user memory-store id would be sourced from the Principal.
export function memoryCollectionFor(session: Session): string {
  if (session.user?.isAuthenticated && session.user.sub) return session.user.sub;
  return session.sessionId;
}

export interface CreateSessionParams {
  sessionId: string;
  workspaceId: string;
  conversationId: string;
  parentSessionId?: string;
  externalReferenceKey?: string;
}

// pure: persistence and id minting stay with the caller, so this touches neither disk nor randomness
export function createSession(params: CreateSessionParams): Session {
  const now = Date.now();
  return {
    sessionId: params.sessionId,
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    parentSessionId: params.parentSessionId,
    externalReferenceKey: params.externalReferenceKey,
    memoryCollectionId: undefined,
    status: "idle",
    counters: { turns: 0 },
    createdAt: now,
    updatedAt: now,
  };
}
