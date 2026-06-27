// One-off, idempotent provisioner for the agentlocal Postgres: roles/users (bootstrap), the database,
// per-service schemas + default privileges, every app table (dbup), then grants on what now exists.
// Re-runnable — each step is guarded or IF-NOT-EXISTS. Connects as the superuser the compose stack
// creates (POSTGRES_USER, default `agent`). Run: `npm run db:provision` from src/postgres.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { AGENT_LOCAL_SCHEMA } from "./migration/schema.js";
import { ensureSchema } from "./migration/dbup.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_DIR = resolve(HERE, "bootstrap");

// superuser connection parts, matching the compose stack's env (src/postgres/docker-compose.yml).
const HOST = process.env.POSTGRES_HOST ?? "localhost";
const PORT = Number(process.env.POSTGRES_PORT ?? "5432");
const USER = process.env.POSTGRES_USER ?? "agent";
const PASSWORD = process.env.POSTGRES_PASSWORD ?? "agent";
const TARGET_DB = process.env.POSTGRES_DB ?? "agentlocal";

function client(database: string): pg.Client {
  return new pg.Client({ host: HOST, port: PORT, user: USER, password: PASSWORD, database });
}

async function runFile(db: pg.Client, file: string): Promise<void> {
  const sql = await readFile(resolve(BOOTSTRAP_DIR, file), "utf-8");
  await db.query(sql);
  log(`applied bootstrap/${file}`);
}

function log(message: string): void {
  console.info(`[provision] ${message}`);
}

// CREATE DATABASE cannot run in a transaction or with IF NOT EXISTS, so guard with a catalog check.
// The compose stack already creates TARGET_DB (POSTGRES_DB), so this is usually a no-op.
async function ensureDatabase(): Promise<void> {
  const admin = client("postgres");
  await admin.connect();
  try {
    const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [TARGET_DB]);
    if (rows.length === 0) {
      await admin.query(`CREATE DATABASE ${quoteIdent(TARGET_DB)}`);
      log(`created database ${TARGET_DB}`);
    } else {
      log(`database ${TARGET_DB} already exists`);
    }
  } finally {
    await admin.end();
  }
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid database name: ${name}`);
  return `"${name}"`;
}

async function main(): Promise<void> {
  await ensureDatabase();

  const db = client(TARGET_DB);
  await db.connect();
  try {
    // roles are cluster-global; applying them on the target connection is fine
    await runFile(db, "01_roles.sql");
    await runFile(db, "02_schemas.sql");
    await ensureSchema(db, AGENT_LOCAL_SCHEMA, { info: log });
    await runFile(db, "03_grants.sql");
    log("done");
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  console.error(`[provision] failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
