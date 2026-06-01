import path from "node:path";
import fs from "node:fs/promises";

/**
 * Workspace guard.
 *
 * Every filesystem-touching tool must resolve user-supplied paths through
 * `resolveSafe`. The guard answers two questions:
 *
 *   1. What absolute path does this string refer to?
 *   2. Is that path inside the configured workspace root?
 *
 * If the answer to (2) is no, we throw before any disk access happens.
 * This is the single defense against the model wandering the filesystem.
 */

export class WorkspaceViolationError extends Error {
  constructor(requestedPath: string, workspaceRoot: string) {
    super(
      `Path "${requestedPath}" resolves outside the workspace root "${workspaceRoot}". ` +
        `Refusing the operation.`
    );
    this.name = "WorkspaceViolationError";
  }
}

export interface Workspace {
  readonly root: string;
  resolveSafe(userPath: string): string;
  relativize(absolutePath: string): string;
}

export function createWorkspace(rawRoot: string): Workspace {
  const root = path.resolve(rawRoot);

  function resolveSafe(userPath: string): string {
    // Treat a bare "." or "" as "the workspace root itself".
    const candidate = userPath === "" || userPath === "." ? root : userPath;

    // If the caller passed a relative path, anchor it at the workspace root.
    const absolute = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(root, candidate);

    // Normalise both sides so "C:\\Foo" and "c:\\foo\\" compare correctly on Windows.
    const normalisedRoot = path.resolve(root) + path.sep;
    const normalisedAbsolute = absolute + path.sep;

    const isInside =
      normalisedAbsolute === normalisedRoot ||
      normalisedAbsolute.startsWith(normalisedRoot);

    if (!isInside) {
      throw new WorkspaceViolationError(userPath, root);
    }

    return absolute;
  }

  function relativize(absolutePath: string): string {
    const rel = path.relative(root, absolutePath);
    return rel === "" ? "." : rel;
  }

  return { root, resolveSafe, relativize };
}

/**
 * Convenience: read the workspace root from the environment, defaulting
 * to the process's current working directory.
 */
export async function workspaceFromEnv(): Promise<Workspace> {
  const raw = process.env.AGENT_WORKSPACE ?? ".";
  const workspace = createWorkspace(raw);

  // Confirm the directory exists so we fail fast on misconfiguration
  // rather than on the first tool call.
  await fs.access(workspace.root);
  return workspace;
}
