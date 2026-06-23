import { randomUUID } from "node:crypto";

// a unit of work the host opened on the agent. The host owns workId (the unit) and workspaceId (the shared
// folder guid); the agent owns the sessionId it mints here and the binding back to the workspace, so each
// later job resolves the right folder under workspaces/<workspaceId> from the sessionId it carries.
export interface SessionRecord {
  sessionId: string;
  workspaceId: string;
  workId: string;
  // the end-user this session belongs to, when the host opened it for one (cli sessions). undefined for a job
  // session, which is owned by the workflow, not a user. The cli stream route matches the caller against this.
  userId?: string;
}

// owns the agent's session ids and their binding to the host's work unit
// in-memory: a session lives for the run; a process restart drops the map (sessions on disk are separate)
export class SessionRegistry {
  private readonly byId = new Map<string, SessionRecord>();

  // resolve the live session for this work, rehydrating the binding when the caller carries a known id. With a
  // `sessionId` (the host's cached cli session), re-register THAT id so its persisted conversation resumes intact
  // after a restart dropped the in-memory map. Without one, reuse the live session for this work/owner, else mint.
  // Persistence is the caller's call (keyed on the durable store), so this only owns the in-memory binding.
  // userId is set only for user-facing (cli) sessions; a job session (userId undefined) keys distinctly from a cli
  // session on the same work, so the two never collide.
  public create(workspaceId: string, workId: string, userId?: string, sessionId?: string): SessionRecord {
    if (sessionId) {
      const known = this.byId.get(sessionId);
      if (known) return known;
      const record: SessionRecord = { sessionId, workspaceId, workId, userId };
      this.byId.set(sessionId, record);
      return record;
    }
    const existing = this.findByWork(workId, userId);
    if (existing) return existing;
    const record: SessionRecord = { sessionId: randomUUID(), workspaceId, workId, userId };
    this.byId.set(record.sessionId, record);
    return record;
  }

  public get(sessionId: string): SessionRecord | undefined {
    return this.byId.get(sessionId);
  }

  // the live session for a work/owner, if one is still registered; the idempotency key for create
  private findByWork(workId: string, userId?: string): SessionRecord | undefined {
    for (const record of this.byId.values()) {
      if (record.workId === workId && record.userId === userId) return record;
    }
    return undefined;
  }

  public close(sessionId: string): boolean {
    return this.byId.delete(sessionId);
  }
}
