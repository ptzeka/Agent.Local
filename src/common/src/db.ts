import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

import type { ILogger } from "./ilogger.js";

// re-exported so consumers hold a typed handle without taking a direct better-sqlite3 dependency
export type DatabaseHandle = Database.Database;

// ---------------------------------------------------------------------------
// Schema spec — the declarative target a process hands the engine at startup
// ---------------------------------------------------------------------------

export type SqlValue = string | number | null;

// a foreign key on THIS table; SQLite has no ALTER ADD FK, so it is rendered INTO the CREATE TABLE
// and reconciled by table-drift detection, never added to a live table
export interface ForeignKeySpec {
  column: string;
  // target as "table" plus the referenced column, e.g. references: "job_status", refColumn: "status"
  references: string;
  refColumn: string;
}

export interface IndexSpec {
  name: string;
  // raw column list, e.g. "user_id, status"
  columns: string;
  unique?: boolean;
}

// reference rows kept in sync from a template: each row is upserted on the table's conflict key
export interface LookupSpec {
  conflictColumns: string[];
  rows: Record<string, SqlValue>[];
}

export interface TableSpec {
  name: string;
  // column + table-constraint DDL lines placed inside CREATE TABLE (...), WITHOUT the foreign keys
  // (those come from foreignKeys so an FK is declared exactly once). A PK line is just another entry.
  columns: string[];
  foreignKeys?: ForeignKeySpec[];
  indexes?: IndexSpec[];
  lookup?: LookupSpec;
}

export interface SchemaSpec {
  // declared parent-before-child: a table must precede any table whose FK references it
  tables: TableSpec[];
}

export interface EnsureOptions {
  logger?: ILogger;
  // on column/FK drift, drop+recreate the table. Safe for throwaway local data; the only way to add an
  // FK or change a column in SQLite. Off => drift is logged and left alone.
  recreateOnDrift?: boolean;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

// opens (creating the file + parent dir) a WAL-mode connection with FK enforcement on. One writer process
// per file is assumed — each of our DBs (host, agent) is owned by exactly one process.
export function openDatabase(file: string): DatabaseHandle {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

// ---------------------------------------------------------------------------
// dbup — idempotent schema reconcile run at startup
// ---------------------------------------------------------------------------

// brings the database up to `schema`: missing tables/indexes are created, drifted ones recreated (when
// allowed), and lookup rows hydrated. Idempotent — a second run with the same spec is a no-op.
export function ensureSchema(db: DatabaseHandle, schema: SchemaSpec, options: EnsureOptions = {}): void {
  const recreateOnDrift = options.recreateOnDrift ?? true;
  // FK enforcement must be OFF while reconciling so a drift-recreate can drop a referenced table; it also
  // cannot be toggled inside a transaction, so the whole reconcile sits between the two pragmas
  db.pragma("foreign_keys = OFF");
  const run = db.transaction(() => {
    for (const table of schema.tables) ensureTable(db, table, recreateOnDrift, options.logger);
    for (const table of schema.tables) ensureIndexes(db, table, options.logger);
    for (const table of schema.tables) hydrateLookup(db, table);
  });
  run();
  db.pragma("foreign_keys = ON");
  // surfaces a lookup/seed row that points at a missing parent — a spec bug, not a data bug
  const violations = db.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    options.logger?.warn?.(`[dbup] foreign_key_check found ${violations.length} violation(s) after ensure`);
  }
}

function ensureTable(
  db: Database.Database,
  table: TableSpec,
  recreateOnDrift: boolean,
  logger?: ILogger,
): void {
  const desired = renderCreateTable(table);
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table.name) as { sql: string } | undefined;

  if (!row) {
    db.exec(desired);
    logger?.info?.(`[dbup] created table ${table.name}`);
    return;
  }
  if (normalizeDdl(row.sql) === normalizeDdl(desired)) return;

  // drift: columns or FKs differ from the spec. SQLite can only express that by rebuilding the table.
  if (!recreateOnDrift) {
    logger?.warn?.(`[dbup] table ${table.name} drifted from spec; recreateOnDrift is off, leaving as-is`);
    return;
  }
  db.exec(`DROP TABLE ${quote(table.name)}`);
  db.exec(desired);
  logger?.warn?.(`[dbup] table ${table.name} drifted from spec — recreated (local data dropped)`);
}

function ensureIndexes(db: Database.Database, table: TableSpec, logger?: ILogger): void {
  for (const index of table.indexes ?? []) {
    const desired = renderCreateIndex(table.name, index);
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(index.name) as { sql: string } | undefined;
    if (row && normalizeDdl(row.sql) === normalizeDdl(desired)) continue;
    if (row) db.exec(`DROP INDEX ${quote(index.name)}`);
    db.exec(desired);
    logger?.info?.(`[dbup] ${row ? "recreated" : "created"} index ${index.name}`);
  }
}

function hydrateLookup(db: Database.Database, table: TableSpec): void {
  const lookup = table.lookup;
  if (!lookup || lookup.rows.length === 0) return;
  const columns = Object.keys(lookup.rows[0]!);
  // non-key columns are refreshed from the template on conflict so an edited label/template propagates
  const updates = columns.filter((c) => !lookup.conflictColumns.includes(c));
  const placeholders = columns.map(() => "?").join(", ");
  const onConflict =
    updates.length > 0
      ? `DO UPDATE SET ${updates.map((c) => `${quote(c)} = excluded.${quote(c)}`).join(", ")}`
      : "DO NOTHING";
  const sql =
    `INSERT INTO ${quote(table.name)} (${columns.map(quote).join(", ")}) VALUES (${placeholders}) ` +
    `ON CONFLICT (${lookup.conflictColumns.map(quote).join(", ")}) ${onConflict}`;
  const stmt = db.prepare(sql);
  for (const row of lookup.rows) stmt.run(...columns.map((c) => row[c] ?? null));
}

// ---------------------------------------------------------------------------
// DDL rendering
// ---------------------------------------------------------------------------

function renderCreateTable(table: TableSpec): string {
  const lines = [...table.columns];
  for (const fk of table.foreignKeys ?? []) {
    lines.push(`FOREIGN KEY (${quote(fk.column)}) REFERENCES ${quote(fk.references)} (${quote(fk.refColumn)})`);
  }
  return `CREATE TABLE ${quote(table.name)} (${lines.join(", ")})`;
}

function renderCreateIndex(tableName: string, index: IndexSpec): string {
  const unique = index.unique ? "UNIQUE " : "";
  return `CREATE ${unique}INDEX ${quote(index.name)} ON ${quote(tableName)} (${index.columns})`;
}

// sqlite_master stores the CREATE text verbatim; collapsing whitespace makes the compare robust to the
// engine's minor reformatting without a full DDL parser (a false-positive only recreates throwaway data)
function normalizeDdl(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
