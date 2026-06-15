// All SQL for the commit-metadata + migration side lives in this file. Chunk
// storage moved to @agent-local/vectorstore; this repo now owns only the
// snapshot bookkeeping (commits) and the migration journal (schema_versions).

import type { DbConnection } from './types.js';
import type { CommitRow } from '../types.js';

export interface AppliedMigration {
  scriptName: string;
  checksum: string;
}

// snapshot/commit bookkeeping + migration journal; the vector store owns chunk rows
export interface CommitRepository {
  ensureSchemaVersionsTable(conn: DbConnection): Promise<void>;
  getAppliedMigrations(conn: DbConnection): Promise<AppliedMigration[]>;
  recordMigration(conn: DbConnection, scriptName: string, checksum: string): Promise<void>;

  acquireAdvisoryLock(conn: DbConnection, key: number): Promise<void>;
  releaseAdvisoryLock(conn: DbConnection, key: number): Promise<void>;

  upsertCommit(conn: DbConnection, commit: CommitRow): Promise<void>;
}

const SQL = {
  createSchemaVersions: `
    CREATE TABLE IF NOT EXISTS schema_versions (
      script_name  TEXT PRIMARY KEY,
      applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum     TEXT NOT NULL
    )
  `,

  selectAppliedMigrations: `
    SELECT script_name AS "scriptName", checksum
    FROM schema_versions
    ORDER BY script_name ASC
  `,

  insertAppliedMigration: `
    INSERT INTO schema_versions (script_name, checksum)
    VALUES ($1, $2)
  `,

  acquireAdvisoryLock: `SELECT pg_advisory_lock($1)`,
  releaseAdvisoryLock: `SELECT pg_advisory_unlock($1)`,

  upsertCommit: `
    INSERT INTO commits (commit_sha, branch, repository, embed_model, embed_dim, file_count, chunk_count)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (commit_sha) DO UPDATE
      SET branch = EXCLUDED.branch,
          repository = EXCLUDED.repository,
          embed_model = EXCLUDED.embed_model,
          embed_dim = EXCLUDED.embed_dim,
          file_count = EXCLUDED.file_count,
          chunk_count = EXCLUDED.chunk_count,
          indexed_at = now()
  `,
};

export class PgCommitRepositoryImpl implements CommitRepository {
  async ensureSchemaVersionsTable(conn: DbConnection): Promise<void> {
    await conn.query(SQL.createSchemaVersions);
  }

  async getAppliedMigrations(conn: DbConnection): Promise<AppliedMigration[]> {
    const result = await conn.query<AppliedMigration>(SQL.selectAppliedMigrations);
    return result.rows;
  }

  async recordMigration(conn: DbConnection, scriptName: string, checksum: string): Promise<void> {
    await conn.query(SQL.insertAppliedMigration, [scriptName, checksum]);
  }

  async acquireAdvisoryLock(conn: DbConnection, key: number): Promise<void> {
    await conn.query(SQL.acquireAdvisoryLock, [key]);
  }

  async releaseAdvisoryLock(conn: DbConnection, key: number): Promise<void> {
    await conn.query(SQL.releaseAdvisoryLock, [key]);
  }

  async upsertCommit(conn: DbConnection, commit: CommitRow): Promise<void> {
    await conn.query(SQL.upsertCommit, [
      commit.commitSha,
      commit.branch,
      commit.repository,
      commit.embedModel,
      commit.embedDim,
      commit.fileCount,
      commit.chunkCount,
    ]);
  }
}
