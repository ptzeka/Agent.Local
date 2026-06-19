import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// the work unit the host orchestrates: the join that ONLY the host holds, tying the user's request to the
// camunda instance and the agent session. jobId is the workId — the id the host hands the agent and gets
// echoed back. step/camundaId track the workflow; sessionId is the agent's local id, recorded for audit.
export type JobStatus = "new" | "running" | "stuck" | "cancelled" | "error" | "completed";

export interface JobRecord {
  jobId: string;
  status: JobStatus;
  // current camunda element/step (null until the workflow reports one)
  step: string | null;
  // the agent session this job runs under (from /session/create); null until associated
  sessionId: string | null;
  // camunda processInstanceKey; null until the instance starts
  camundaId: string | null;
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

  // seeds a brand-new work unit; the host calls this when web creates the request, before camunda/agent ids exist
  public async add(jobId: string): Promise<JobRecord> {
    const record: JobRecord = {
      jobId,
      status: "new",
      step: null,
      sessionId: null,
      camundaId: null,
      ts: new Date().toISOString(),
    };
    await this.write(record);
    return record;
  }

  // current state == last line for the id; null when the job was never added
  public async get(jobId: string): Promise<JobRecord | null> {
    const byId = await this.foldLatest();
    return byId.get(jobId) ?? null;
  }

  // every job's current state, newest-first; an optional status filter narrows it (the web list/search view)
  public async search(filter?: { status?: JobStatus }): Promise<JobRecord[]> {
    const records = [...(await this.foldLatest()).values()];
    const matched = filter?.status ? records.filter((r) => r.status === filter.status) : records;
    return matched.sort((a, b) => b.ts.localeCompare(a.ts));
  }

  // merges a patch onto the latest state and appends it as a new line; no-op return null if the job is unknown
  public async update(
    jobId: string,
    patch: Partial<Omit<JobRecord, "jobId" | "ts">>,
  ): Promise<JobRecord | null> {
    const current = await this.get(jobId);
    if (!current) return null;
    const next: JobRecord = { ...current, ...patch, jobId, ts: new Date().toISOString() };
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
