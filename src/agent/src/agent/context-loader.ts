import path from "node:path";
import fs from "node:fs/promises";

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
