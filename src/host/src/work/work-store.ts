import type { DatabaseHandle, SqlValue } from "@agent-local/common/db";

// the work-unit lifecycle, defined once in work-status.ts (the canonical status catalog that also seeds the
// db-schema work_status lookup). Re-exported here so WorkRecord consumers keep importing it from the store.
export type { WorkStatus } from "./work-status.js";
import type { WorkStatus } from "./work-status.js";

// the read model the host orchestrates: the join ONLY the host holds, tying the user's request to the temporal
// run. temporalId is joined in from work_temporal — normalized out of the row but surfaced here so callers read one
// flat record. Agent sessions are NOT folded in: a work owns many per-step job sessions now (work_agent_session
// kind=job), so they are queried separately. step carries the descriptive "where we are" (it absorbed the old
// statusDescription: stop/failure reasons live here too).
export interface WorkRecord {
  workId: string;
  // the owner: the userSub (cookie identity) that created the work. search/get scope to this so a user
  // only ever sees their own works; seeded once at add() and never rewritten.
  userId: string;
  // the workflow type this work runs; null only for legacy records created before it was tracked
  workflowId: string | null;
  // the agent workspace this work runs in (minted at trigger, same id handed to /session/create)
  workspaceId: string | null;
  status: WorkStatus;
  // current step / descriptive context: the running element, or the stop/failure reason, or the terminal value
  step: string | null;
  // the Temporal instance id (work_temporal); null until the instance starts
  temporalId: string | null;
  // ISO timestamp the work was first added; set once at add() and carried forward unchanged
  createdAt: string;
  // ISO timestamp of the last update (the work table's updated_at)
  ts: string;
}

// the mutable surface of a work: work-table fields plus the normalized temporal child id (null releases it)
export type WorkPatch = {
  status?: WorkStatus;
  step?: string | null;
  workflowId?: string | null;
  workspaceId?: string | null;
  temporalId?: string | null;
};

// the row shape the join returns before mapping to camelCase
interface WorkRow {
  work_id: string;
  user_id: string;
  workflow_id: string | null;
  workspace_id: string | null;
  status: WorkStatus;
  step: string | null;
  temporal_id: string | null;
  created_at: string;
  updated_at: string;
}

// host-owned work store on host.sqlite: a work is normalized across `work` + its child session/temporal tables,
// and every read folds them back into one WorkRecord. The DB handle is opened once at startup and injected.
export class WorkStore {
  private constructor(private readonly db: DatabaseHandle) {}

  public static create(db: DatabaseHandle): WorkStore {
    return new WorkStore(db);
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  // current state == the joined row; null when the work was never added
  public async get(workId: string): Promise<WorkRecord | null> {
    const row = this.db.prepare(`${SELECT_WORK} WHERE w.work_id = ?`).get(workId) as WorkRow | undefined;
    return row ? toRecord(row) : null;
  }

  // every work's current state, newest-first; filters narrow it. userId scopes to one owner (the web list/search
  // view always passes it so a user sees only their own works); status narrows further.
  public async search(filter?: { userId?: string; status?: WorkStatus }): Promise<WorkRecord[]> {
    const where: string[] = [];
    const values: SqlValue[] = [];
    if (filter?.userId) {
      where.push("w.user_id = ?");
      values.push(filter.userId);
    }
    if (filter?.status) {
      where.push("w.status = ?");
      values.push(filter.status);
    }
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const rows = this.db.prepare(`${SELECT_WORK}${clause} ORDER BY w.updated_at DESC`).all(...values) as WorkRow[];
    return rows.map(toRecord);
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  // seeds a brand-new work unit owned by userId; the host calls this when web creates the request, before
  // temporal/agent ids exist. userId is the cookie identity and is fixed for the life of the work.
  public async add(
    workId: string,
    userId: string,
    workflowId: string | null = null,
    workspaceId: string | null = null,
  ): Promise<WorkRecord> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO work (user_id, work_id, workflow_id, workspace_id, status, step, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, 'new', NULL, ?, ?)",
      )
      .run(userId, workId, workflowId, workspaceId, now, now);
    return (await this.get(workId))!;
  }

  // merges a patch onto the work and its children, in one transaction, then returns the rejoined record; null when
  // the work is unknown. work-table fields update `work` (and always bump updated_at); sessionId/temporalId upsert
  // (or, when null, delete) the child rows — so clearing sessionId on close is the idempotent release.
  public async update(workId: string, patch: WorkPatch): Promise<WorkRecord | null> {
    const exists = this.db.prepare("SELECT 1 FROM work WHERE work_id = ?").get(workId);
    if (!exists) return null;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const sets = ["updated_at = ?"];
      const values: SqlValue[] = [now];
      if (patch.status !== undefined) (sets.push("status = ?"), values.push(patch.status));
      if ("step" in patch) (sets.push("step = ?"), values.push(patch.step ?? null));
      if ("workflowId" in patch) (sets.push("workflow_id = ?"), values.push(patch.workflowId ?? null));
      if ("workspaceId" in patch) (sets.push("workspace_id = ?"), values.push(patch.workspaceId ?? null));
      this.db.prepare(`UPDATE work SET ${sets.join(", ")} WHERE work_id = ?`).run(...values, workId);

      if ("temporalId" in patch) this.upsertTemporal(workId, patch.temporalId ?? null, now);
    })();
    return this.get(workId);
  }

  // the work's interactive CLI session (work_agent_session kind='cli'), independent of the kind='job' workflow
  // session joined into WorkRecord; null until a cli stream is opened. One per work via the (work_id, kind) key.
  public async getCliSessionId(workId: string): Promise<string | null> {
    const row = this.db
      .prepare("SELECT session_id FROM work_agent_session WHERE work_id = ? AND kind = 'cli'")
      .get(workId) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  // idempotent bind of the work's cli session: upserts on the partial cli unique index (one cli row per work) so a
  // re-init reuses the row. run_key/step_key are NULL — they discriminate job sessions only.
  public async setCliSessionId(workId: string, sessionId: string): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO work_agent_session (session_id, work_id, kind, run_key, step_key, created_at) " +
          "VALUES (?, ?, 'cli', NULL, NULL, ?) " +
          "ON CONFLICT (work_id) WHERE kind = 'cli' DO UPDATE SET session_id = excluded.session_id",
      )
      .run(sessionId, workId, new Date().toISOString());
  }

  // ---------------------------------------------------------------------------
  // Job (per-step) sessions
  // ---------------------------------------------------------------------------

  // the session already bound to one step of a run, if any — the idempotency key for openJobSession so an activity
  // retry for the same (work, run_key, step_key) reuses its session instead of minting a second one.
  public async getJobSessionId(workId: string, runKey: string, stepKey: string): Promise<string | null> {
    const row = this.db
      .prepare("SELECT session_id FROM work_agent_session WHERE work_id = ? AND kind = 'job' AND run_key = ? AND step_key = ?")
      .get(workId, runKey, stepKey) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  // bind a freshly minted session to one step of a run; unique on (work_id, run_key, step_key) for kind=job
  public async addJobSession(workId: string, sessionId: string, runKey: string, stepKey: string): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO work_agent_session (session_id, work_id, kind, run_key, step_key, created_at) " +
          "VALUES (?, ?, 'job', ?, ?, ?)",
      )
      .run(sessionId, workId, runKey, stepKey, new Date().toISOString());
  }

  // every live job session id for a work — the sweep set closed on stop/complete/fail/reset (the discard rule)
  public async listJobSessionIds(workId: string): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT session_id FROM work_agent_session WHERE work_id = ? AND kind = 'job'")
      .all(workId) as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }

  // drop one job session row (after its agent session is closed); idempotent — a missing row is a no-op
  public async removeJobSession(sessionId: string): Promise<void> {
    this.db.prepare("DELETE FROM work_agent_session WHERE session_id = ? AND kind = 'job'").run(sessionId);
  }

  // 1:1 temporal run per work (work_id PK): a non-null id upserts, null drops the row
  private upsertTemporal(workId: string, temporalId: string | null, now: string): void {
    if (temporalId === null) {
      this.db.prepare("DELETE FROM work_temporal WHERE work_id = ?").run(workId);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO work_temporal (work_id, temporal_id, created_at) VALUES (?, ?, ?) " +
          "ON CONFLICT (work_id) DO UPDATE SET temporal_id = excluded.temporal_id",
      )
      .run(workId, temporalId, now);
  }
}

// the join every read shares: the temporal run folded onto the work row. Agent sessions are NOT joined — a work
// owns many per-step job sessions, so a 1:1 fold would multiply rows; they are read via the job-session queries.
const SELECT_WORK =
  "SELECT w.work_id, w.user_id, w.workflow_id, w.workspace_id, w.status, w.step, w.created_at, w.updated_at, " +
  "t.temporal_id AS temporal_id " +
  "FROM work w " +
  "LEFT JOIN work_temporal t ON t.work_id = w.work_id";

function toRecord(row: WorkRow): WorkRecord {
  return {
    workId: row.work_id,
    userId: row.user_id,
    workflowId: row.workflow_id,
    workspaceId: row.workspace_id,
    status: row.status,
    step: row.step,
    temporalId: row.temporal_id,
    createdAt: row.created_at,
    ts: row.updated_at,
  };
}
