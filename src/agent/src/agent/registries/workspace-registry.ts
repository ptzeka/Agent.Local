import { loadProjectContext, type ProjectContext } from "../context/context-loader.js";

/**
 * WorkspaceRegistry — Repository layer.
 *
 * Resolves a `workspaceId` to its filesystem root and project context.
 * Because the orchestrator now reads context from the workspace (not from
 * its own instance state), any sessions sharing a `workspaceId` automatically
 * share the same standing direction — this is what makes "several sessions
 * working a common goal" coherent.
 *
 * The registry is an in-memory cache built per run by the Initializer; the
 * underlying context read stays in context-loader so all filesystem access
 * remains in this layer.
 */

export interface Workspace {
  workspaceId: string;
  /** Root used to resolve project context (agentcontext.md). */
  root: string;
  /** Standing direction for this workspace, or null when none is present. */
  projectContext: ProjectContext | null;
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();

  /**
   * Register a workspace, loading its context from disk. Idempotent: a
   * second call with an already-known id returns the existing entry without
   * re-reading, so joining a shared workspace is cheap.
   */
  public async register(workspaceId: string, root: string): Promise<Workspace> {
    const existing = this.workspaces.get(workspaceId);
    if (existing) return existing;

    const projectContext = await loadProjectContext(root);
    const workspace: Workspace = { workspaceId, root, projectContext };
    this.workspaces.set(workspaceId, workspace);
    return workspace;
  }

  public get(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Unknown workspaceId "${workspaceId}". Register it before use.`);
    }
    return workspace;
  }

  public has(workspaceId: string): boolean {
    return this.workspaces.has(workspaceId);
  }

  /**
   * Re-read the context file for an already-registered workspace, picking up
   * any mid-session edits to agentcontext.md. Returns the refreshed entry.
   */
  public async reload(workspaceId: string): Promise<Workspace> {
    const workspace = this.get(workspaceId);
    const projectContext = await loadProjectContext(workspace.root);
    const updated: Workspace = { ...workspace, projectContext };
    this.workspaces.set(workspaceId, updated);
    return updated;
  }
}
