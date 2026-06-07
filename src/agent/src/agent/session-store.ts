import fs from "node:fs/promises";
import path from "node:path";

import type { Session } from "./session.js";

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
  private constructor(private readonly directory: string) {}

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
   * Map a sessionId to its file. The id is sanitised so a hostile or
   * malformed value can't escape the store directory via path traversal.
   */
  private fileFor(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return path.join(this.directory, `${safe}.json`);
  }
}
