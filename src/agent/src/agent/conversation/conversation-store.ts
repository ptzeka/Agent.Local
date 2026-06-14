import fs from "node:fs/promises";
import path from "node:path";

import type { ChatMessage } from "../providers/provider.js";

// deletion is soft: deletedAt hides the conversation from normal reads while the
// JSONL stays as the audit copy until a future retention sweep hard-deletes it
export interface ConversationMeta {
  conversationId: string;
  createdAt: number;
  // null while alive; set once on soft-delete
  deletedAt: number | null;
}

// one JSONL file per conversation: append is the hot path (one appended line, no rewrite)
// rewrites happen only on summarize/compact/reset, via temp + rename so a torn write can't corrupt
export class ConversationStore {
  private constructor(private readonly directory: string) {}

  // own subfolder so session pickers globbing `*.json` never pick up transcripts
  public static create(sessionsDir: string): ConversationStore {
    return new ConversationStore(path.resolve(sessionsDir, "conversations"));
  }

  public async append(conversationId: string, messages: readonly ChatMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await fs.mkdir(this.directory, { recursive: true });
    const lines = messages.map((message) => JSON.stringify(message)).join("\n") + "\n";
    await fs.appendFile(this.fileFor(conversationId), lines, "utf8");
  }

  // null for missing or soft-deleted: deleted transcripts stay readable only via the file directly
  // torn lines are skipped, not fatal, so the transcript up to a crash tear still loads
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
        // torn last line from a crash mid-append: skip rather than fail the whole load
      }
    }
    return messages;
  }

  // backup renames the outgoing transcript aside (O(1)) because summarization is lossy
  // and the pre-summary generation must survive for audit/undo; trim passes false (healing, not history)
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

  public async readMeta(conversationId: string): Promise<ConversationMeta | null> {
    try {
      const raw = await fs.readFile(this.metaFileFor(conversationId), "utf8");
      return JSON.parse(raw) as ConversationMeta;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

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

  // idempotent: a repeat call keeps the original timestamp and finds no live file to move
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

  // sanitises the id so a hostile or malformed value can't escape the store via path traversal
  private fileFor(conversationId: string): string {
    return path.join(this.directory, `${sanitize(conversationId)}.jsonl`);
  }

  private metaFileFor(conversationId: string): string {
    return path.join(this.directory, `${sanitize(conversationId)}.meta.json`);
  }

  // fixed names by design: a new backup overwrites the prior one, keeping only the latest generation
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
