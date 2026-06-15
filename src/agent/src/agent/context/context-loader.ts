import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

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

// reads project direction once and snapshots it, hashed, for both planner and executor
// so every turn carries the same direction without the user re-typing it
export class ContextLoader
{
  constructor(private readonly contextsDir: string) {};

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

  public async saveContextSnapshot(
    snapshot: ContextSnapshot
  ): Promise<string> {
    const dir = path.resolve(this.contextsDir);
    const hash = this.hashContextSnapshot(snapshot);
    const target = path.join(dir, `${hash}.json`);

    try {
      await fs.access(target);
      // identical snapshot already on disk: hash is content-addressed, so reuse it
      return hash;
    } catch {
      // absent: fall through and write it
    }

    await fs.mkdir(dir, { recursive: true });
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
    await fs.rename(tmp, target);
    return hash;
  }

  // null (not throw) on a missing snapshot: pre-snapshot sessions and pruned dirs are expected
  public async getContextSnapshot(
    hash: string | undefined
  ): Promise<ContextSnapshot | null> {
    // a session persisted before its role had a pointer carries no hash
    if (!hash) return null;
    // sanitise so a malformed pointer can't escape the contexts dir
    const safe = hash.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const target = path.join(path.resolve(this.contextsDir), `${safe}.json`);
    try {
      return JSON.parse(await fs.readFile(target, "utf8")) as ContextSnapshot;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
}