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

export interface ProjectContext {
  /** Absolute path the content was read from. Surfaced in the banner. */
  sourcePath: string;
  /** Trimmed file body. Empty files are treated as "no context". */
  content: string;
}

// Use a namespaced subdirectory so the file is clearly Agent.Local's
// (rather than something a different tool might also try to read).
const DEFAULT_RELATIVE_PATH = path.join("src", "context", "agentcontext.md");

export async function loadProjectContext(
  workspaceRoot: string
): Promise<ProjectContext | null> {
  const override = process.env.AGENT_CONTEXT_FILE?.trim();
  const target = resolveTarget(workspaceRoot, override);

  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Default case: most projects don't ship an AGENTS.md. Silent.
      return null;
    }
    process.stderr.write(
      `[context] failed to read ${target}: ${(err as Error).message}\n`
    );
    return null;
  }

  const content = raw.trim();
  if (content.length === 0) {
    return null;
  }

  return { sourcePath: target, content };
}

/**
 * Re-read the context file from disk.
 *
 * Semantically identical to `loadProjectContext`, but named so callers
 * (the Orchestrator's reset path) express intent clearly: pick up any
 * edits made to agentcontext.md mid-session. Kept in this module so the
 * file read stays in the Repository layer — the Orchestrator never
 * touches the filesystem itself.
 */
export function reloadProjectContext(
  workspaceRoot: string
): Promise<ProjectContext | null> {
  return loadProjectContext(workspaceRoot);
}

function resolveTarget(workspaceRoot: string, override: string | undefined): string {
  if (!override || override.length === 0) {
    return path.resolve(workspaceRoot, DEFAULT_RELATIVE_PATH);
  }
  return path.isAbsolute(override)
    ? path.resolve(override)
    : path.resolve(workspaceRoot, override);
}

// ---------------------------------------------------------------------------
// Context snapshots (content-addressed)
// ---------------------------------------------------------------------------

/**
 * A frozen record of the non-conversation context sent to the orchestrator:
 * the system prompt, project direction, and the tool block. The session stores
 * only a hash pointer into this; the snapshot itself is written once per unique
 * fingerprint, so identical context across many sessions costs one file. Used
 * for documentation/debugging — "what context did session X actually run on".
 */
export interface ContextSnapshot {
  /** Orchestrator model id this context targeted. */
  model: string;
  /** The base orchestrator system prompt. */
  systemPrompt: string;
  /** Whether tools were sent natively (true) vs. as prompted JSON instructions. */
  nativeTools: boolean;
  /** Project direction in effect, or null when the workspace ships none. */
  projectContext: { sourcePath: string; content: string } | null;
  /** Tool descriptors advertised to the orchestrator, sorted by name. */
  tools: ToolDescriptor[];
}

/**
 * Assemble a ContextSnapshot from its parts. Pure: the caller (ContextMiddleware)
 * gathers the live inputs and hands them in, keeping the filesystem/registry
 * wiring out of this module. Tools are sorted by name so the same logical
 * context always hashes identically regardless of registry iteration order.
 */
export function buildContextSnapshot(input: {
  model: string;
  systemPrompt: string;
  nativeTools: boolean;
  projectContext: ProjectContext | null;
  tools: ToolDescriptor[];
}): ContextSnapshot {
  return {
    model: input.model,
    systemPrompt: input.systemPrompt,
    nativeTools: input.nativeTools,
    projectContext: input.projectContext
      ? { sourcePath: input.projectContext.sourcePath, content: input.projectContext.content }
      : null,
    tools: [...input.tools].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Stable 16-hex-char fingerprint of a snapshot. Relies on buildContextSnapshot
 * producing a deterministic field/tool order, so equal context → equal hash.
 */
export function hashContextSnapshot(snapshot: ContextSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 16);
}

/**
 * Persist a snapshot to `<contextsDir>/<hash>.json` and return the hash.
 *
 * Content-addressed and write-once: if the file already exists its content is
 * identical by construction, so the write is skipped. Writes go through a temp
 * file + rename to avoid leaving a partial file on a crash, mirroring SessionStore.
 */
export async function saveContextSnapshot(
  contextsDir: string,
  snapshot: ContextSnapshot
): Promise<string> {
  const dir = path.resolve(contextsDir);
  const hash = hashContextSnapshot(snapshot);
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
export async function getContextSnapshot(
  contextsDir: string,
  hash: string
): Promise<ContextSnapshot | null> {
  // Sanitise the hash so a malformed pointer can't escape the contexts dir.
  const safe = hash.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const target = path.join(path.resolve(contextsDir), `${safe}.json`);
  try {
    return JSON.parse(await fs.readFile(target, "utf8")) as ContextSnapshot;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
