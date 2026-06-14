import path from "node:path";
import fs from "node:fs/promises";

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
    // a bare "." or "" means the workspace root itself
    const candidate = userPath === "" || userPath === "." ? root : userPath;

    // anchor a relative path at the workspace root
    const absolute = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(root, candidate);

    // trailing sep on both sides so "C:\\Foo" and "c:\\foo\\" compare correctly on Windows
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

// reads the workspace root from env, defaulting to cwd
export async function workspaceFromEnv(): Promise<Workspace> {
  const raw = process.env.AGENT_WORKSPACE ?? ".";
  const workspace = createWorkspace(raw);

  // fail fast on misconfiguration rather than on the first tool call
  await fs.access(workspace.root);
  return workspace;
}
