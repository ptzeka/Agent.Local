import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { openDatabase, ensureSchema, type SchemaSpec, type DatabaseHandle } from "@agent-local/common/db";
import type { ILogger } from "@agent-local/common";

// the work-unit statuses, mirrored from JobRecord["status"]; the lookup table makes them an FK domain so a
// row can never carry a status the host doesn't know about, and documents the enum in the data itself
const JOB_STATUSES = ["new", "running", "stuck", "cancelled", "stopped", "error", "completed"] as const;

// the host DB target schema (host.sqlite). The repository swap onto these tables is M3-H; dbup only ensures
// the shape exists at startup so the table is ready the moment the repository lands.
export const HOST_SCHEMA: SchemaSpec = {
  tables: [
    {
      name: "job_status",
      columns: ["status TEXT PRIMARY KEY", "label TEXT NOT NULL"],
      lookup: {
        conflictColumns: ["status"],
        rows: JOB_STATUSES.map((status) => ({ status, label: status })),
      },
    },
    {
      name: "jobs",
      // current-state row per work unit, keyed by owner+job so a query can never cross users (M3 design rule)
      columns: [
        "user_id TEXT NOT NULL",
        "job_id TEXT NOT NULL",
        "workflow_id TEXT",
        "status TEXT NOT NULL",
        "step TEXT",
        "session_id TEXT",
        "camunda_id TEXT",
        "reason TEXT",
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
