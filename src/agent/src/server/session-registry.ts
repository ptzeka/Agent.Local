import { randomUUID } from "node:crypto";

// a unit of work the host opened on the agent. The host owns workId (the unit) and workspaceId (the shared
// folder guid); the agent owns the sessionId it mints here and the binding back to the workspace, so each
// later job resolves the right folder under workspaces/<workspaceId> from the sessionId it carries.
export interface SessionRecord {
  sessionId: string;
  workspaceId: string;
  workId: string;
}

// owns the agent's session ids and their binding to the host's work unit
// in-memory: a session lives for the run; a process restart drops the map (sessions on disk are separate)
export class SessionRegistry {
  private readonly byId = new Map<string, SessionRecord>();

  // mints a fresh session bound to the host's work unit; the workspace folder derives from workspaceId
  public create(workspaceId: string, workId: string): SessionRecord {
    const record: SessionRecord = { sessionId: randomUUID(), workspaceId, workId };
    this.byId.set(record.sessionId, record);
    return record;
  }

  public get(sessionId: string): SessionRecord | undefined {
    return this.byId.get(sessionId);
  }

  public close(sessionId: string): boolean {
    return this.byId.delete(sessionId);
  }
}
