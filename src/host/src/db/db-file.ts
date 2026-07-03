import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { openDatabase, ensureSchema, type DatabaseHandle } from "@agent-local/common/db";
import type { ILogger } from "@agent-local/common";
import { HOST_SCHEMA } from "./db-schema.js";

// where host.sqlite lives and how startup opens it — split from db-schema so the schema module stays pure
// (importable by tests and the API) while the import.meta package-root walk stays on the startup path only.

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
    if (parent === cursor) throw new Error("host: could not locate package.json above the db loader");
    cursor = parent;
  }
}
