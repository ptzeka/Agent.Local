// resolves a workspaceId to its root so sessions sharing the id share standing direction,
// which is what makes "several sessions working a common goal" coherent; in-memory cache per run
export interface Workspace {
  workspaceId: string;
  // root used to resolve project context (agentcontext.md)
  root: string;
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();

  // idempotent so joining a shared workspace is cheap: a known id returns the existing entry
  public async register(workspaceId: string, root: string): Promise<Workspace> {
    const existing = this.workspaces.get(workspaceId);
    if (existing) return existing;

    const workspace: Workspace = { workspaceId, root };
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

  // re-reads so mid-session edits to agentcontext.md are picked up
  public async reload(workspaceId: string): Promise<Workspace> {
    const workspace = this.get(workspaceId);
    const updated: Workspace = { ...workspace };
    this.workspaces.set(workspaceId, updated);
    return updated;
  }
}
