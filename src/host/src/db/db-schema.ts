import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { openDatabase, ensureSchema, type SchemaSpec, type DatabaseHandle } from "@agent-local/common/db";
import type { ILogger } from "@agent-local/common";
import { WORK_STATUS_CODES, type StatusCode, type StatusTone } from "../work/work-status.js";

// the host DB target schema (host.sqlite). The work store reads/writes these tables (M3-H); dbup ensures the
// shape exists at startup. A work is normalized across three tables: `work` holds the unit's own state, while
// agent sessions and the temporal run are split into children so a work can carry many sessions and per-engine
// metadata can grow without widening the core row.
export const HOST_SCHEMA: SchemaSpec = {
  tables: [
    {
      // the status-code lookup: an FK domain so a work row can never carry an unknown status, AND the catalog the
      // /api/works/statuscodes endpoint serves. Carries label + presentation tone + action flags so the UI is
      // fully data-driven. SQLite has no boolean, so the flags are 0/1 INTEGER columns.
      name: "work_status",
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
        rows: WORK_STATUS_CODES.map((s) => ({
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
      name: "work",
      // current-state row per work unit, keyed by owner+work so a query can never cross users (M3 design rule).
      // session_id/temporal_id are NOT here — they are normalized out to work_agent_session / work_temporal;
      // `step` is the descriptive "where we are" (it absorbed the old status_description: stop/failure reasons too).
      columns: [
        "user_id TEXT NOT NULL",
        "work_id TEXT NOT NULL",
        "workflow_id TEXT",
        "workspace_id TEXT",
        "status TEXT NOT NULL",
        "step TEXT",
        "created_at TEXT NOT NULL",
        "updated_at TEXT NOT NULL",
        "PRIMARY KEY (user_id, work_id)",
      ],
      foreignKeys: [{ column: "status", references: "work_status", refColumn: "status" }],
      // work_id is unique on its own (a uuid) — declared so the child tables below can FK to it despite the
      // composite owner+work PK; the user scope still gates every read at the query layer.
      indexes: [
        { name: "idx_work_user_status", columns: "user_id, status" },
        { name: "idx_work_work_id", columns: "work_id", unique: true },
      ],
    },
    {
      // the agent sessions a work owns, split out of work.session_id so a work can have more than one: kind=job
      // is the workflow's own session (exactly one per work, enforced below); kind=cli is a standalone user chat.
      name: "work_agent_session",
      columns: [
        "session_id TEXT PRIMARY KEY",
        "work_id TEXT NOT NULL",
        "kind TEXT NOT NULL CHECK (kind IN ('job', 'cli'))",
        "created_at TEXT NOT NULL",
      ],
      foreignKeys: [{ column: "work_id", references: "work", refColumn: "work_id" }],
      // one session per (work, kind): a work has at most one kind=job session and one kind=cli session
      indexes: [{ name: "idx_work_agent_session_work_kind", columns: "work_id, kind", unique: true }],
    },
    {
      // the temporal run backing a work, split out of work.temporal_id so engine-specific metadata can grow
      // here without widening work; 1:1 with the work (work_id PK), populated once the instance starts.
      name: "work_temporal",
      columns: [
        "work_id TEXT PRIMARY KEY",
        "temporal_id TEXT NOT NULL",
        "created_at TEXT NOT NULL",
      ],
      foreignKeys: [{ column: "work_id", references: "work", refColumn: "work_id" }],
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
    .prepare("SELECT status, label, tone, terminal, stoppable, continuable FROM work_status")
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
