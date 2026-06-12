import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

import type { ToolDescriptor } from "../providers/provider.js";

/**
 * Project context loader.
 *
 * Reads a single direction file at startup (default:
 * `src/context/agentcontext.md` under the workspace root, overridable with
 * AGENT_CONTEXT_FILE) and returns its contents. The path is deliberately
 * namespaced so it doesn't collide with other agent conventions like
 * AGENTS.md or CLAUDE.md.
 *
 * The orchestrator injects this string as a leading system message for
 * BOTH the planner and the executor, so every turn carries project-specific
 * direction without the user re-typing it.
 *
 * Missing files are not an error — most projects won't have one.
 */

export interface ContextSnapshot {
  /** Role this context targeted. */
  role: string;
  /** The base orchestrator system prompt. */
  systemPrompt: string;
  /** Whether tools were sent natively (true) vs. as prompted JSON instructions. */
  nativeTools: boolean;
  /** Project direction in effect, or null when the workspace ships none. */
  projectContext: string;
  /**
   * Tool descriptors advertised to the role, captured in the order advertised.
   * Any change to the tool set (membership or order) yields a different hash and
   * therefore a new context snapshot.
   */
  tools: ToolDescriptor[];
}


// Use a namespaced subdirectory so the file is clearly Agent.Local's
// (rather than something a different tool might also try to read).
const DEFAULT_RELATIVE_PATH = path.join("src", "context", "agentcontext.md");

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
      return hash; // already captured — nothing to do
    } catch {
      // not present — fall through and write it
    }

    await fs.mkdir(dir, { recursive: true });
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
    await fs.rename(tmp, target);
    return hash;
  }

  /**
   * Read a previously saved snapshot by hash. Returns null when no such snapshot
   * exists (e.g. a session persisted before snapshots, or a pruned contexts dir).
   */
  public async getContextSnapshot(
    hash: string | undefined
  ): Promise<ContextSnapshot | null> {
    // A session persisted before a role's pointer existed has no hash at all —
    // treat that the same as a pruned snapshot rather than crashing.
    if (!hash) return null;
    // Sanitise the hash so a malformed pointer can't escape the contexts dir.
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