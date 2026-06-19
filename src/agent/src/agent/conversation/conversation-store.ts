import type { DatabaseHandle } from "@agent-local/common/db";

import type { ChatMessage } from "../providers/provider.js";

// deletion is soft: deletedAt hides the conversation from normal reads while the
// messages rows stay as the audit copy until a future retention sweep hard-deletes them
export interface ConversationMeta {
  conversationId: string;
  createdAt: number;
  // null while alive; set once on soft-delete
  deletedAt: number | null;
}

// transcript persistence on agent.sqlite: one `conversations` row per transcript, one `messages` row per
// line ordered by seq. Replaces the per-file JSONL folder layout; the DB handle is opened once at process
// startup and injected, so the store owns no connection of its own.
export class ConversationStore {
  private constructor(private readonly db: DatabaseHandle) {}

  public static create(db: DatabaseHandle): ConversationStore {
    return new ConversationStore(db);
  }

  // appends to the tail: seq continues past the current max so a concurrent reader never sees a gap.
  // ensures the parent row first so the FK holds even if append races ahead of ensureMeta
  public async append(conversationId: string, messages: readonly ChatMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const insert = this.db.prepare(
      "INSERT INTO messages (conversation_id, seq, payload) VALUES (?, ?, ?)",
    );
    const tx = this.db.transaction((rows: readonly ChatMessage[]) => {
      this.ensureRow(conversationId);
      let seq = this.nextSeq(conversationId);
      for (const message of rows) insert.run(conversationId, seq++, JSON.stringify(message));
    });
    tx(messages);
  }

  // null for missing or soft-deleted: a deleted transcript stays readable only by querying past the deletedAt guard
  public async load(conversationId: string): Promise<ChatMessage[] | null> {
    const meta = await this.readMeta(conversationId);
    if (!meta || meta.deletedAt) return null;
    const rows = this.db
      .prepare("SELECT payload FROM messages WHERE conversation_id = ? ORDER BY seq")
      .all(conversationId) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as ChatMessage);
  }

  // summarization/reset rewrites the whole transcript in one transaction (delete + re-seed from 0).
  // backup is a no-op: the relational layout keeps no generation copy (the JSONL .bak rename is gone);
  // a retention/audit table is a later add if undo is needed
  public async rewrite(
    conversationId: string,
    messages: readonly ChatMessage[],
    _options: { backup?: boolean } = {},
  ): Promise<void> {
    const insert = this.db.prepare(
      "INSERT INTO messages (conversation_id, seq, payload) VALUES (?, ?, ?)",
    );
    const tx = this.db.transaction((rows: readonly ChatMessage[]) => {
      this.ensureRow(conversationId);
      this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
      let seq = 0;
      for (const message of rows) insert.run(conversationId, seq++, JSON.stringify(message));
    });
    tx(messages);
  }

  // --------------------------------------------------------------------------
  // Lifecycle metadata (create/delete dates, soft-delete flag)
  // --------------------------------------------------------------------------

  public async readMeta(conversationId: string): Promise<ConversationMeta | null> {
    const row = this.db
      .prepare("SELECT conversation_id, created_at, deleted_at FROM conversations WHERE conversation_id = ?")
      .get(conversationId) as { conversation_id: string; created_at: number; deleted_at: number | null } | undefined;
    if (!row) return null;
    return { conversationId: row.conversation_id, createdAt: row.created_at, deletedAt: row.deleted_at };
  }

  public async ensureMeta(conversationId: string): Promise<ConversationMeta> {
    this.ensureRow(conversationId);
    return (await this.readMeta(conversationId))!;
  }

  // idempotent: a repeat call keeps the original deletedAt (the guard skips an already-set row)
  public async markDeleted(conversationId: string): Promise<ConversationMeta> {
    this.ensureRow(conversationId);
    this.db
      .prepare("UPDATE conversations SET deleted_at = ? WHERE conversation_id = ? AND deleted_at IS NULL")
      .run(Date.now(), conversationId);
    return (await this.readMeta(conversationId))!;
  }

  public async isDeleted(conversationId: string): Promise<boolean> {
    const meta = await this.readMeta(conversationId);
    return meta?.deletedAt != null;
  }

  // INSERT OR IGNORE so the create date is stamped exactly once, the first time a conversation comes alive
  private ensureRow(conversationId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO conversations (conversation_id, created_at, deleted_at) VALUES (?, ?, NULL)")
      .run(conversationId, Date.now());
  }

  private nextSeq(conversationId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), -1) AS max FROM messages WHERE conversation_id = ?")
      .get(conversationId) as { max: number };
    return row.max + 1;
  }
}
