import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// the work unit the host orchestrates: the join that ONLY the host holds, tying the user's request to the
// temporal instance and the agent session. jobId is the workId — the id the host hands the agent and gets
// echoed back. step/temporalId track the workflow; sessionId is the agent's local id, recorded for audit.
// the work-unit lifecycle, defined once in job-status.ts (the canonical status catalog that also seeds the
// db-schema job_status lookup). Re-exported here so existing JobRecord consumers keep importing it from the registry.
export type { JobStatus } from "./job-status.js";
import type { JobStatus } from "./job-status.js";

export interface JobRecord {
  jobId: string;
  // the owner: the userSub (cookie identity) that created the work. search/get scope to this so a user
  // only ever sees their own works; seeded once at add() and never rewritten.
  userId: string;
  // the workflow type this work runs; null only for legacy records created before it was tracked
  workflowId: string | null;
  // the agent workspace this work runs in (minted at trigger, same id handed to /session/create); null only
  // for legacy records created before it was tracked
  workspaceId: string | null;
  status: JobStatus;
  // current workflow element/step (null until the workflow reports one)
  step: string | null;
  // the agent session this job runs under (from /session/create); null until associated
  sessionId: string | null;
  // the Temporal instance id (the engine's primary key for this run); null until the instance starts
  temporalId: string | null;
  // live context for the CURRENT status: running step, stop/failure reason, or the workflow's
  // terminal return value (e.g. "user table created"). null when the status needs no further explanation.
  statusDescription: string | null;
  // ISO timestamp the work was first added; set once at add() and carried forward unchanged by update(),
  // so it survives the fold-to-latest (unlike ts, which every update rewrites)
  createdAt: string;
  // ISO timestamp of THIS line — a later line for the same jobId supersedes it
  ts: string;
}

// host-owned job store, mirroring MetricsStore: every add/update appends one JSONL line and the current
// state of a job is the LAST line bearing its id. No rewrite — status changes are just newer lines, so a
// torn write can never corrupt prior history. Lives in host/jobs so the host can list/search work units.
export class JobRegistry {
  private readonly file: string;

  constructor(file?: string) {
    this.file = file ?? resolveJobsFile();
  }

  // seeds a brand-new work unit owned by userId; the host calls this when web creates the request, before
  // temporal/agent ids exist. userId is the cookie identity and is fixed for the life of the work.
  public async add(
    jobId: string,
    userId: string,
    workflowId: string | null = null,
    workspaceId: string | null = null,
  ): Promise<JobRecord> {
    const now = new Date().toISOString();
    const record: JobRecord = {
      jobId,
      userId,
      workflowId,
      workspaceId,
      status: "new",
      step: null,
      sessionId: null,
      temporalId: null,
      statusDescription: null,
      createdAt: now,
      ts: now,
    };
    await this.write(record);
    return record;
  }

  // current state == last line for the id; null when the job was never added
  public async get(jobId: string): Promise<JobRecord | null> {
    const byId = await this.foldLatest();
    return byId.get(jobId) ?? null;
  }

  // every job's current state, newest-first; filters narrow it. userId scopes to one owner (the web list/search
  // view always passes it so a user sees only their own works); status narrows further.
  public async search(filter?: { userId?: string; status?: JobStatus }): Promise<JobRecord[]> {
    const records = [...(await this.foldLatest()).values()];
    const matched = records.filter(
      (r) => (!filter?.userId || r.userId === filter.userId) && (!filter?.status || r.status === filter.status),
    );
    return matched.sort((a, b) => b.ts.localeCompare(a.ts));
  }

  // merges a patch onto the latest state and appends it as a new line; no-op return null if the job is unknown
  public async update(
    jobId: string,
    patch: Partial<Omit<JobRecord, "jobId" | "createdAt" | "ts">>,
  ): Promise<JobRecord | null> {
    const current = await this.get(jobId);
    if (!current) return null;
    // createdAt is intentionally not spread from patch — it carries forward from current untouched
    const next: JobRecord = { ...current, ...patch, jobId, createdAt: current.createdAt, ts: new Date().toISOString() };
    await this.write(next);
    return next;
  }

  // dir made on write, not in the ctor, so merely constructing a registry touches no filesystem
  private async write(record: JobRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.appendFile(this.file, JSON.stringify(record) + "\n", "utf8");
  }

  // folds the JSONL to one record per jobId (last line wins); a torn line is skipped, never fatal
  private async foldLatest(): Promise<Map<string, JobRecord>> {
    const byId = new Map<string, JobRecord>();
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch {
      // no file yet (no jobs created) — empty registry
      return byId;
    }
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      try {
        const record = JSON.parse(line) as JobRecord;
        byId.set(record.jobId, record);
      } catch {
        // a torn or partial line never invalidates the rest of the file
      }
    }
    return byId;
  }
}

// HOST_JOBS_FILE wins; else <package root>/jobs/jobs.jsonl, anchored like appsettings so it resolves the
// same whether the process runs from src (tsx dev) or dist (built)
function resolveJobsFile(): string {
  if (process.env.HOST_JOBS_FILE) return path.resolve(process.env.HOST_JOBS_FILE);
  return path.join(findPackageRoot(), "jobs", "jobs.jsonl");
}

function findPackageRoot(): string {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(cursor, "package.json"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("host: could not locate package.json above the job registry");
    cursor = parent;
  }
}
