import fs from "node:fs/promises";
import path from "node:path";

import { ConversationStore } from "../conversation/conversation-store.js";
import type { ChatMessage } from "../providers/provider.js";
import type { Session } from "./session.js";

// the small shape a picker needs without loading and parsing every session file itself
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

// one JSON file per session: zero new deps and trivially inspectable; writes go temp+rename so a crash can't corrupt
// durability is turn-boundary, save() runs after each completed turn
export class SessionStore {
  // sessions carry only the conversationId link, so summaries() follows it through this sibling store
  private readonly conversations: ConversationStore;

  private constructor(private readonly directory: string) {
    this.conversations = ConversationStore.create(directory);
  }

  public static create(directory: string): SessionStore {
    return new SessionStore(path.resolve(directory));
  }

  public async save(session: Session): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const target = this.fileFor(session.sessionId);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(session, null, 2), "utf8");
    await fs.rename(tmp, target);
  }

  public async load(sessionId: string): Promise<Session | null> {
    try {
      const raw = await fs.readFile(this.fileFor(sessionId), "utf8");
      return JSON.parse(raw) as Session;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  public async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.directory);
      return entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => entry.slice(0, -".json".length));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  // corrupt files are skipped, not fatal; sub-sessions are omitted since they aren't standalone-resumable
  public async summaries(): Promise<SessionSummary[]> {
    const ids = await this.list();
    const summaries: SessionSummary[] = [];
    for (const id of ids) {
      const session = await this.load(id).catch(() => null);
      if (!session) continue;
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

  // sanitises the id so a hostile or malformed value can't escape the store via path traversal
  private fileFor(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return path.join(this.directory, `${safe}.json`);
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
