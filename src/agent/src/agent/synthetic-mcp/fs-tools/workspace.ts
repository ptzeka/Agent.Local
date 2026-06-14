import path from "node:path";

// the single defence against the model wandering the filesystem: every fs tool resolves user paths
// through resolveSafe, which throws before any disk access if the path lands outside the workspace root
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
    // reject traversal early so hostile input fails fast, surfacing the offending path, not a resolved-absolute one
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
