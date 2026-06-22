import path from "node:path";
import { openDatabase, ensureSchema, type SchemaSpec, type DatabaseHandle } from "@agent-local/common/db";
import type { ILogger } from "@agent-local/common";

// the agent DB target schema (agent.sqlite): sessions, their conversation transcripts, and per-session
// metrics — the relational stores from M3-2. Memo stays out (it is the vectorstore track). The repository
// swap onto these tables is M3-2; dbup only ensures the shape exists at startup.
export const AGENT_SCHEMA: SchemaSpec = {
  tables: [
    {
      name: "session_status",
      columns: ["status TEXT PRIMARY KEY", "label TEXT NOT NULL"],
      lookup: {
        conflictColumns: ["status"],
        rows: ["new", "running", "awaiting_input", "capped", "satisfied", "failed", "error"].map((status) => ({
          status,
          label: status,
        })),
      },
    },
    {
      name: "sessions",
      // user_sub is part of the key so no path can hydrate another user's session (M3 design rule); the whole
      // session object lives in `payload` JSON until columns are needed for a query
      columns: [
        "user_sub TEXT NOT NULL",
        "session_id TEXT NOT NULL",
        "status TEXT NOT NULL",
        "payload TEXT NOT NULL",
        "created_at INTEGER NOT NULL",
        "updated_at INTEGER NOT NULL",
        "PRIMARY KEY (user_sub, session_id)",
      ],
      foreignKeys: [{ column: "status", references: "session_status", refColumn: "status" }],
      // summaries() orders most-recent-first per owner; the index serves that scan
      indexes: [{ name: "idx_sessions_user_updated", columns: "user_sub, updated_at DESC" }],
    },
    {
      name: "conversations",
      // deleted_at NULL while alive; set once on soft-delete (mirrors ConversationMeta)
      columns: [
        "conversation_id TEXT PRIMARY KEY",
        "created_at INTEGER NOT NULL",
        "deleted_at INTEGER",
      ],
    },
    {
      name: "messages",
      // one row per transcript line; seq orders them. FK to conversations replaces the per-file folder layout
      columns: [
        "conversation_id TEXT NOT NULL",
        "seq INTEGER NOT NULL",
        "payload TEXT NOT NULL",
        "PRIMARY KEY (conversation_id, seq)",
      ],
      foreignKeys: [{ column: "conversation_id", references: "conversations", refColumn: "conversation_id" }],
    },
    {
      name: "contexts",
      // content-addressed snapshot store: hash = sha256(payload) prefix, so a row is immutable and the
      // write is dedup-by-hash. Replaces the <contextsDir>/<hash>.json files; sessions point in by hash
      columns: [
        "hash TEXT PRIMARY KEY",
        "payload TEXT NOT NULL",
        "created_at INTEGER NOT NULL",
      ],
    },
    {
      name: "metrics",
      // current cumulative tally per session (the JSONL "last line wins" collapses to one upserted row)
      columns: [
        "session_id TEXT PRIMARY KEY",
        "parent_session_id TEXT",
        "payload TEXT NOT NULL",
        "updated_at TEXT NOT NULL",
      ],
    },
  ],
};

// AGENT_DB_FILE (ops override) wins; else the appsettings db.file; else <cwd>/data/agent.sqlite
export function resolveAgentDbFile(configured?: string): string {
  if (process.env.AGENT_DB_FILE) return path.resolve(process.env.AGENT_DB_FILE);
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), "data", "agent.sqlite");
}

// opens agent.sqlite and brings it up to AGENT_SCHEMA; call once at startup before serving
export function ensureAgentDb(logger?: ILogger): DatabaseHandle {
  const db = openDatabase(resolveAgentDbFile());
  ensureSchema(db, AGENT_SCHEMA, { logger });
  return db;
}
