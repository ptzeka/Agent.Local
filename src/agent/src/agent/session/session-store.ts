import fs from "node:fs/promises";
import path from "node:path";

import { ConversationStore } from "../conversation/conversation-store.js";
import type { ChatMessage } from "../providers/provider.js";
import type { Session } from "./session.js";

/**
 * Lightweight description of a persisted session, enough for a picker to show
 * a useful row without the caller having to load and parse every file itself.
 */
export interface SessionSummary {
  sessionId: string;
  /** Epoch millis of the last persist; drives most-recent-first ordering. */
  updatedAt: number;
  /** Completed user turns. */
  turns: number;
  /** Truncated first user message, or null when the transcript has none yet. */
  preview: string | null;
}

/** Cap on preview length so a long opening message can't wreck the layout. */
const PREVIEW_MAX_LENGTH = 60;

/**
 * SessionStore — Repository layer.
 *
 * Persists one JSON file per session under a single directory. Chosen for
 * zero new dependencies and trivial inspectability; it mirrors the
 * file-repository pattern already used in codeindex.
 *
 * Durability is turn-boundary: the Initializer calls `save` after each
 * completed turn. Writes go through a temp file + rename so a crash
 * mid-write can never corrupt an existing session file.
 */
export class SessionStore {
  /** Sibling store for transcript previews — sessions only carry the
   *  conversationId link, so summaries() must follow it. */
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

  /**
   * Summaries of every persisted top-level session, most-recently-updated
   * first. Loads each file once and projects it to the small shape a picker
   * needs; files that fail to parse (partial/corrupt) are skipped rather than
   * aborting the whole listing.
   *
   * Sub-sessions (any session carrying a `parentSessionId`) are deliberately
   * omitted: they are persisted for durability/inspection but are not
   * resumable as standalone sessions, so the startup picker must never offer
   * them.
   */
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

  /**
   * Map a sessionId to its file. The id is sanitised so a hostile or
   * malformed value can't escape the store directory via path traversal.
   */
  private fileFor(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return path.join(this.directory, `${safe}.json`);
  }
}

/**
 * First user message of a transcript, whitespace-collapsed and truncated, to
 * hint at what the session was about. Returns null when no user turn exists yet.
 */
function firstUserPreview(messages: readonly ChatMessage[]): string | null {
  const firstUser = messages.find((message) => message.role === "user");
  if (!firstUser) return null;
  const flat = firstUser.content.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  return flat.length > PREVIEW_MAX_LENGTH ? `${flat.slice(0, PREVIEW_MAX_LENGTH - 1)}…` : flat;
}
