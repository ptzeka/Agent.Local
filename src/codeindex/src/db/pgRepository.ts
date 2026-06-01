// All SQL for the writer side lives in this file. No other module in
// tools/codeindex/src may contain SQL statements — the migration runner
// (publish/migrate.ts) is the only documented exception, and it streams
// .sql files from disk rather than embedding SQL in TypeScript.

import type { DbConnection } from './types.js';
import type { ChunkRow, CommitRow } from '../types.js';

export interface AppliedMigration {
  scriptName: string;
  checksum: string;
}

export interface PgWriterRepository {
  ensureSchemaVersionsTable(conn: DbConnection): Promise<void>;
  getAppliedMigrations(conn: DbConnection): Promise<AppliedMigration[]>;
  recordMigration(conn: DbConnection, scriptName: string, checksum: string): Promise<void>;

  acquireAdvisoryLock(conn: DbConnection, key: number): Promise<void>;
  releaseAdvisoryLock(conn: DbConnection, key: number): Promise<void>;

  upsertCommit(conn: DbConnection, commit: CommitRow): Promise<void>;
  deleteChunksForCommit(conn: DbConnection, commitSha: string): Promise<void>;
  insertChunks(conn: DbConnection, commitSha: string, chunks: ChunkRow[]): Promise<void>;

  getEmbeddingDimension(conn: DbConnection): Promise<number | null>;
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

  deleteChunksForCommit: `DELETE FROM chunks WHERE commit_sha = $1`,

  insertChunk: `
    INSERT INTO chunks (
      commit_sha, path, area, language, kind, symbol, parent_symbol,
      start_line, end_line, content, content_hash, imports, claude_md, embedding
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13, $14::vector
    )
  `,

  selectEmbeddingDim: `
    SELECT atttypmod AS "dim"
    FROM pg_attribute
    WHERE attrelid = 'chunks'::regclass
      AND attname  = 'embedding'
  `,
};

export class PgWriterRepositoryImpl implements PgWriterRepository {
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

  async deleteChunksForCommit(conn: DbConnection, commitSha: string): Promise<void> {
    await conn.query(SQL.deleteChunksForCommit, [commitSha]);
  }

  async insertChunks(conn: DbConnection, commitSha: string, chunks: ChunkRow[]): Promise<void> {
    for (const chunk of chunks) {
      await conn.query(SQL.insertChunk, [
        commitSha,
        chunk.path,
        chunk.area,
        chunk.language,
        chunk.kind,
        chunk.symbol,
        chunk.parentSymbol,
        chunk.startLine,
        chunk.endLine,
        chunk.content,
        chunk.contentHash,
        chunk.imports,
        chunk.claudeMd,
        toVectorLiteral(chunk.embedding),
      ]);
    }
  }

  async getEmbeddingDimension(conn: DbConnection): Promise<number | null> {
    const result = await conn.query<{ dim: number }>(SQL.selectEmbeddingDim);
    if (result.rows.length === 0) return null;
    const first = result.rows[0];
    if (!first) return null;
    // pg_attribute.atttypmod stores the vector dimension directly for the
    // pgvector extension (no -4 offset, unlike varchar's typmod).
    return first.dim ?? null;
  }
}

function toVectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}
