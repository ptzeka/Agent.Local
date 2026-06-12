import path from "node:path";

/**
 * Workspace guard (moved in-process from the former fsmcp server).
 *
 * Every filesystem-touching builtin tool must resolve user-supplied paths
 * through `resolveSafe`. The guard answers two questions:
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
    // Reject parent-traversal segments before any OS-level resolution. The
    // containment check below would catch escapes too, but an early explicit
    // reject makes hostile input fail fast and surfaces the offending path
    // directly rather than a resolved-absolute one.
    if (/(^|[/\\])\.\.($|[/\\])/.test(userPath)) {
      throw new WorkspaceViolationError(userPath, root);
    }

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
