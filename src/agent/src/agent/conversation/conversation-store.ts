import fs from "node:fs/promises";
import path from "node:path";

import type { ChatMessage } from "../providers/provider.js";

/**
 * Per-conversation lifecycle record, persisted as a `<id>.meta.json` sidecar
 * next to the transcript. Deletion is SOFT: `deletedAt` marks the conversation
 * dead for every normal read path, while the JSONL file itself is retained as
 * the audit copy until some future retention sweep hard-deletes it.
 */
export interface ConversationMeta {
  conversationId: string;
  /** Epoch millis when the conversation was first opened. */
  createdAt: number;
  /** Epoch millis when it was soft-deleted; null while alive. */
  deletedAt: number | null;
}

/**
 * ConversationStore — Repository layer.
 *
 * Persists one JSONL file per conversation under `<sessionsDir>/conversations`.
 * JSONL (one JSON-encoded message per line) was chosen over the session's
 * pretty-printed JSON because the hot operation is APPEND: adding a message is
 * a single `appendFile` of one line, never a rewrite of the whole transcript.
 * Full rewrites happen only on the rare structural events (summarize, compact,
 * reset) and go through temp file + rename so a crash mid-write can never
 * corrupt an existing conversation file.
 */
export class ConversationStore {
  private constructor(private readonly directory: string) {}

  /** `sessionsDir` is the session store's directory; conversations live in a
   *  sibling-free subfolder so session pickers globbing `*.json` never see them. */
  public static create(sessionsDir: string): ConversationStore {
    return new ConversationStore(path.resolve(sessionsDir, "conversations"));
  }

  public async append(conversationId: string, messages: readonly ChatMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await fs.mkdir(this.directory, { recursive: true });
    const lines = messages.map((message) => JSON.stringify(message)).join("\n") + "\n";
    await fs.appendFile(this.fileFor(conversationId), lines, "utf8");
  }

  /**
   * Load every message of a conversation; null when no file exists yet OR the
   * conversation is soft-deleted — deleted transcripts are filtered out of
   * every normal select, readable only by going to the file directly (audit).
   * Unparseable lines (a torn last line from a crash mid-append) are skipped
   * rather than failing the whole load — the transcript up to the tear is
   * still usable.
   */
  public async load(conversationId: string): Promise<ChatMessage[] | null> {
    const meta = await this.readMeta(conversationId);
    if (meta?.deletedAt) return null;

    let raw: string;
    try {
      raw = await fs.readFile(this.fileFor(conversationId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }

    const messages: ChatMessage[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      try {
        messages.push(JSON.parse(line) as ChatMessage);
      } catch {
        /* torn line — skip */
      }
    }
    return messages;
  }

  /**
   * Replace the whole file atomically — for summarize/compact/trim. With
   * `backup`, the outgoing transcript is first preserved by a plain rename to
   * `<id>.bak.json` (O(1), no copy): summarization is lossy, so the
   * pre-summary generation stays on disk for audit/undo. Trim passes
   * false — dropping one dangling tool_use is healing, not history.
   */
  public async rewrite(
    conversationId: string,
    messages: readonly ChatMessage[],
    options: { backup?: boolean } = {}
  ): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const target = this.fileFor(conversationId);
    if (options.backup) {
      await this.renameIfExists(target, this.backupFileFor(conversationId, "bak"));
    }
    const tmp = `${target}.tmp`;
    const body = messages.map((message) => JSON.stringify(message)).join("\n");
    await fs.writeFile(tmp, body.length > 0 ? body + "\n" : "", "utf8");
    await fs.rename(tmp, target);
  }

  // --------------------------------------------------------------------------
  // Lifecycle metadata (create/delete dates, soft-delete flag)
  // --------------------------------------------------------------------------

  /** Read the lifecycle record; null when none was ever written. */
  public async readMeta(conversationId: string): Promise<ConversationMeta | null> {
    try {
      const raw = await fs.readFile(this.metaFileFor(conversationId), "utf8");
      return JSON.parse(raw) as ConversationMeta;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Create the lifecycle record if missing; returns the current one either way. */
  public async ensureMeta(conversationId: string): Promise<ConversationMeta> {
    const existing = await this.readMeta(conversationId);
    if (existing) return existing;
    const meta: ConversationMeta = {
      conversationId,
      createdAt: Date.now(),
      deletedAt: null,
    };
    await this.writeMeta(meta);
    return meta;
  }

  /**
   * Soft-delete: stamp `deletedAt` and move the transcript aside by a plain
   * rename to `<id>.deleted.json` — the audit copy a future retention sweep
   * can hard-delete. Idempotent — a second call keeps the original timestamp
   * and finds no live file to rename.
   */
  public async markDeleted(conversationId: string): Promise<ConversationMeta> {
    const meta = await this.ensureMeta(conversationId);
    if (meta.deletedAt === null) {
      meta.deletedAt = Date.now();
      await this.writeMeta(meta);
    }
    await this.renameIfExists(
      this.fileFor(conversationId),
      this.backupFileFor(conversationId, "deleted")
    );
    return meta;
  }

  public async isDeleted(conversationId: string): Promise<boolean> {
    const meta = await this.readMeta(conversationId);
    return meta?.deletedAt != null;
  }

  private async writeMeta(meta: ConversationMeta): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const target = this.metaFileFor(meta.conversationId);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
    await fs.rename(tmp, target);
  }

  /**
   * Map a conversationId to its file. The id is sanitised so a hostile or
   * malformed value can't escape the store directory via path traversal.
   */
  private fileFor(conversationId: string): string {
    return path.join(this.directory, `${sanitize(conversationId)}.jsonl`);
  }

  private metaFileFor(conversationId: string): string {
    return path.join(this.directory, `${sanitize(conversationId)}.meta.json`);
  }

  /** `<id>.bak.json` / `<id>.deleted.json`. Fixed names by design: a new
   *  backup replaces the previous one (rename overwrites), so only the latest
   *  pre-rewrite generation is kept per conversation. */
  private backupFileFor(conversationId: string, kind: "bak" | "deleted"): string {
    return path.join(this.directory, `${sanitize(conversationId)}.${kind}.json`);
  }

  private async renameIfExists(from: string, to: string): Promise<void> {
    try {
      await fs.rename(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }
}

function sanitize(conversationId: string): string {
  return conversationId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
