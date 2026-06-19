import path from "node:path";
import { createHash } from "node:crypto";

import type { DatabaseHandle } from "@agent-local/common/db";
import type { ToolDescriptor } from "@agent-local/mcp/tooldescriptor";

export interface ContextSnapshot {
  role: string;
  systemPrompt: string;
  // native vs. prompted-JSON tools change the hash, so they belong in the snapshot
  nativeTools: boolean;
  // null when the workspace ships no direction file
  projectContext: string;
  // order matters: any change to tool membership or order yields a new snapshot hash
  tools: ToolDescriptor[];
}


// namespaced so a different tool's AGENTS.md/CLAUDE.md convention can't collide
const DEFAULT_RELATIVE_PATH = path.join("src", "context", "agentcontext.md");

// reads project direction once and snapshots it, hashed, for both planner and executor so every turn carries
// the same direction without the user re-typing it. snapshots live content-addressed in the `contexts` table
// (agent.sqlite); the DB handle is opened once at process startup and injected, so the loader owns no connection
export class ContextLoader
{
  private constructor(private readonly db: DatabaseHandle) {}

  public static create(db: DatabaseHandle): ContextLoader {
    return new ContextLoader(db);
  }

  resolveTarget(workspaceRoot: string, override: string | undefined): string {
    if (!override || override.length === 0) {
      return path.resolve(workspaceRoot, DEFAULT_RELATIVE_PATH);
    }
    return path.isAbsolute(override)
      ? path.resolve(override)
      : path.resolve(workspaceRoot, override);
  }

  hashContextSnapshot(snapshot: ContextSnapshot): string {
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 16);
  }

  public buildContext(
    role: string,
    systemPrompt: string,
    projectTemplate: string,
    tools: ToolDescriptor[],
    nativeTools: boolean
  ): ContextSnapshot {
    return {
      role,
      systemPrompt,
      nativeTools,
      projectContext: projectTemplate,
      tools,
    };
  }

  // write-once: the hash is content-addressed, so INSERT OR IGNORE dedups — a re-save of identical content
  // leaves the existing row (and its created_at) untouched
  public async saveContextSnapshot(
    snapshot: ContextSnapshot
  ): Promise<string> {
    const hash = this.hashContextSnapshot(snapshot);
    this.db
      .prepare("INSERT OR IGNORE INTO contexts (hash, payload, created_at) VALUES (?, ?, ?)")
      .run(hash, JSON.stringify(snapshot), Date.now());
    return hash;
  }

  // null (not throw) on a missing snapshot: pre-snapshot sessions and pruned rows are expected.
  // the parameterized query needs no path sanitisation — a malformed pointer simply misses
  public async getContextSnapshot(
    hash: string | undefined
  ): Promise<ContextSnapshot | null> {
    // a session persisted before its role had a pointer carries no hash
    if (!hash) return null;
    const row = this.db
      .prepare("SELECT payload FROM contexts WHERE hash = ?")
      .get(hash) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as ContextSnapshot) : null;
  }
}