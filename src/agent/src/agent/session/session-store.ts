import type { DatabaseHandle } from "@agent-local/common/db";

import { ConversationStore } from "../conversation/conversation-store.js";
import type { ChatMessage } from "../providers/provider.js";
import type { Session, SessionStatus } from "./session.js";

// the small shape a picker needs without loading and parsing every session itself
export interface SessionSummary {
  sessionId: string;
  // drives most-recent-first ordering
  updatedAt: number;
  turns: number;
  // null when the transcript has no user turn yet
  preview: string | null;
}

// caps preview length so a long opening message can't wreck the layout
const PREVIEW_MAX_LENGTH = 60;

// the runtime's SessionStatus vocabulary projected onto the session_status FK domain (AGENT_SCHEMA). The full
// Session is the source of truth in `payload`; the status column is a denormalized, queryable projection only,
// so it must land inside the FK domain rather than carry the runtime spelling verbatim
const STATUS_TO_DOMAIN: Record<SessionStatus, string> = {
  idle: "new",
  running: "running",
  "awaiting-input": "awaiting_input",
  done: "satisfied",
  error: "error",
};

// session run-state on agent.sqlite: one `sessions` row, the whole Session object in `payload` JSON (M3 design
// rule), with status/dates lifted to columns for queries. The DB handle is opened once at startup and injected.
export class SessionStore {
  // sessions carry only the conversationId link, so summaries() follows it through this sibling store
  private readonly conversations: ConversationStore;

  private constructor(private readonly db: DatabaseHandle) {
    this.conversations = ConversationStore.create(db);
  }

  public static create(db: DatabaseHandle): SessionStore {
    return new SessionStore(db);
  }

  public async save(session: Session): Promise<void> {
    // anonymous sessions have no Principal yet; "anonymous" keeps the (user_sub, session_id) PK satisfied
    const userSub = session.user?.sub ?? "anonymous";
    const status = STATUS_TO_DOMAIN[session.status] ?? "new";
    // external_reference_key is intentionally NOT in the conflict-update set: it's stamped on the first insert
    // and left alone on every later upsert, so the back-reference a session was created with can never drift
    this.db
      .prepare(
        "INSERT INTO sessions (user_sub, session_id, status, external_reference_key, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (user_sub, session_id) DO UPDATE SET status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at",
      )
      .run(
        userSub,
        session.sessionId,
        status,
        session.externalReferenceKey ?? null,
        JSON.stringify(session),
        session.createdAt,
        session.updatedAt,
      );
  }

  // keyed by session_id alone (cross-user, like the old `load`): a session id is a uuid, so a same-id collision
  // across users is not a real case. Use getSessionsByUserId when the caller only has a user, not a session id.
  public async getSessionById(sessionId: string): Promise<Session | null> {
    const row = this.db
      .prepare("SELECT payload FROM sessions WHERE session_id = ?")
      .get(sessionId) as { payload: string } | undefined;
    return row ? parseSession(row) : null;
  }

  // every session owned by one user, most-recent-first — idx_sessions_user_updated (user_sub, updated_at DESC)
  // serves this directly
  public async getSessionsByUserId(userId: string): Promise<Session[]> {
    const rows = this.db
      .prepare("SELECT payload FROM sessions WHERE user_sub = ? ORDER BY updated_at DESC")
      .all(userId) as { payload: string }[];
    return rows.map(parseSession).filter((session): session is Session => session !== null);
  }

  // always owner-scoped: sessions are tied to a user, so no caller may list across users ("anonymous" is
  // the owner bucket for logged-out sessions). Corrupt rows are dropped, not fatal; child sessions are omitted
  // since they aren't standalone-resumable.
  public async summaries(userId: string): Promise<SessionSummary[]> {
    const sessions = await this.getSessionsByUserId(userId);
    const summaries: SessionSummary[] = [];
    for (const session of sessions) {
      if (session.parentSessionId) continue;
      const messages = session.conversationId
        ? await this.conversations.load(session.conversationId).catch(() => null)
        : null;
      summaries.push({
        sessionId: session.sessionId,
        updatedAt: session.updatedAt,
        turns: session.counters.turns,
        preview: firstUserPreview(messages ?? []),
      });
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

// corrupt payloads are skipped by callers rather than thrown, so one bad row can't take the whole list down
function parseSession(row: { payload: string }): Session | null {
  try {
    return JSON.parse(row.payload) as Session;
  } catch {
    return null;
  }
}

// whitespace-collapsed, truncated first user message to hint what the session was about; null when none yet
function firstUserPreview(messages: readonly ChatMessage[]): string | null {
  const firstUser = messages.find((message) => message.role === "user");
  if (!firstUser) return null;
  const flat = firstUser.content.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  return flat.length > PREVIEW_MAX_LENGTH ? `${flat.slice(0, PREVIEW_MAX_LENGTH - 1)}…` : flat;
}
