import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { openDatabase, ensureSchema, type SchemaSpec, type DatabaseHandle } from "@agent-local/common/db";
import type { ILogger } from "@agent-local/common";
import { JOB_STATUS_CODES, type StatusCode, type StatusTone } from "./job-status.js";

// the host DB target schema (host.sqlite). The repository swap onto these tables is M3-H; dbup only ensures
// the shape exists at startup so the table is ready the moment the repository lands.
export const HOST_SCHEMA: SchemaSpec = {
  tables: [
    {
      // the status-code lookup: an FK domain so a job row can never carry an unknown status, AND the catalog the
      // /api/works/statuscodes endpoint serves. Carries label + presentation tone + action flags so the UI is
      // fully data-driven. SQLite has no boolean, so the flags are 0/1 INTEGER columns.
      name: "job_status",
      columns: [
        "status TEXT PRIMARY KEY",
        "label TEXT NOT NULL",
        "tone TEXT NOT NULL",
        "terminal INTEGER NOT NULL",
        "stoppable INTEGER NOT NULL",
        "continuable INTEGER NOT NULL",
      ],
      lookup: {
        conflictColumns: ["status"],
        rows: JOB_STATUS_CODES.map((s) => ({
          status: s.status,
          label: s.label,
          tone: s.tone,
          terminal: s.terminal ? 1 : 0,
          stoppable: s.stoppable ? 1 : 0,
          continuable: s.continuable ? 1 : 0,
        })),
      },
    },
    {
      name: "jobs",
      // current-state row per work unit, keyed by owner+job so a query can never cross users (M3 design rule)
      columns: [
        "user_id TEXT NOT NULL",
        "job_id TEXT NOT NULL",
        "workflow_id TEXT",
        "workspace_id TEXT",
        "status TEXT NOT NULL",
        "step TEXT",
        "session_id TEXT",
        "temporal_id TEXT",
        "status_description TEXT",
        "created_at TEXT NOT NULL",
        "updated_at TEXT NOT NULL",
        "PRIMARY KEY (user_id, job_id)",
      ],
      foreignKeys: [{ column: "status", references: "job_status", refColumn: "status" }],
      indexes: [{ name: "idx_jobs_user_status", columns: "user_id, status" }],
    },
  ],
};

// HOST_DB_FILE (ops override) wins; else the appsettings db.file; else <host package root>/data/host.sqlite.
// a relative configured path anchors to the package root (not cwd) so it resolves the same from src or dist.
export function resolveHostDbFile(configured?: string): string {
  if (process.env.HOST_DB_FILE) return path.resolve(process.env.HOST_DB_FILE);
  if (configured) return path.isAbsolute(configured) ? configured : path.join(findPackageRoot(), configured);
  return path.join(findPackageRoot(), "data", "host.sqlite");
}

// reads the status-code catalog from the live lookup table — the actual source the API serves (not the in-code
// const). Maps the 0/1 INTEGER flags back to booleans so the wire shape matches StatusCode.
export function readStatusCodes(db: DatabaseHandle): StatusCode[] {
  const rows = db
    .prepare("SELECT status, label, tone, terminal, stoppable, continuable FROM job_status")
    .all() as Array<{ status: string; label: string; tone: string; terminal: number; stoppable: number; continuable: number }>;
  return rows.map((r) => ({
    status: r.status,
    label: r.label,
    tone: r.tone as StatusTone,
    terminal: r.terminal === 1,
    stoppable: r.stoppable === 1,
    continuable: r.continuable === 1,
  }));
}

// opens host.sqlite and brings it up to HOST_SCHEMA; call once at startup before serving
export function ensureHostDb(logger?: ILogger): DatabaseHandle {
  const db = openDatabase(resolveHostDbFile());
  ensureSchema(db, HOST_SCHEMA, { logger });
  return db;
}

function findPackageRoot(): string {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(cursor, "package.json"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("host: could not locate package.json above the db schema");
    cursor = parent;
  }
}
