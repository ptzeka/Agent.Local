// All SQL for the reader side lives in this file. No other module in
// src/codemcp/src may contain SQL statements. See tools/codeindex's writer
// repository for the symmetric rule on the writer side.

import type { DbConnection } from './types.js';

export interface CommitRow {
  commitSha: string;
  branch: string;
  repository: string;
  indexedAt: Date;
  embedModel: string;
  embedDim: number;
  fileCount: number;
  chunkCount: number;
}

export interface ChunkRow {
  commitSha: string;
  path: string;
  area: string;
  language: string;
  kind: string;
  symbol: string | null;
  parentSymbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  imports: string[];
  claudeMd: string[];
  score?: number;
}

export interface SearchFilters {
  area?: string;
  kind?: string;
  language?: string;
}

export interface PgReaderRepository {
  getLatestAppliedMigration(conn: DbConnection): Promise<string | null>;
  /**
   * Latest indexed commit on `branch`, optionally scoped to a repository.
   * `repository === null` means "any repository" — used when the server can't
   * detect a current repo and the caller didn't provide one.
   */
  latestCommitFor(
    conn: DbConnection,
    branch: string,
    repository: string | null,
  ): Promise<CommitRow | null>;
  listCommits(
    conn: DbConnection,
    branch: string | null,
    repository: string | null,
    limit: number,
  ): Promise<CommitRow[]>;
  searchByEmbedding(
    conn: DbConnection,
    commitSha: string,
    embedding: number[],
    k: number,
    filters: SearchFilters,
  ): Promise<ChunkRow[]>;
  findSymbol(conn: DbConnection, commitSha: string, name: string): Promise<ChunkRow[]>;
  getFileChunks(conn: DbConnection, commitSha: string, path: string): Promise<ChunkRow[]>;
}

const SQL = {
  latestMigration: `
    SELECT script_name
    FROM schema_versions
    ORDER BY script_name DESC
    LIMIT 1
  `,

  latestCommitFor: `
    SELECT commit_sha   AS "commitSha",
           branch,
           repository,
           indexed_at   AS "indexedAt",
           embed_model  AS "embedModel",
           embed_dim    AS "embedDim",
           file_count   AS "fileCount",
           chunk_count  AS "chunkCount"
    FROM commits
    WHERE branch = $1
      AND ($2::text IS NULL OR repository = $2)
    ORDER BY indexed_at DESC
    LIMIT 1
  `,

  listCommits: `
    SELECT commit_sha   AS "commitSha",
           branch,
           repository,
           indexed_at   AS "indexedAt",
           embed_model  AS "embedModel",
           embed_dim    AS "embedDim",
           file_count   AS "fileCount",
           chunk_count  AS "chunkCount"
    FROM commits
    WHERE ($1::text IS NULL OR branch = $1)
      AND ($2::text IS NULL OR repository = $2)
    ORDER BY indexed_at DESC
    LIMIT $3
  `,

  searchByEmbedding: `
    SELECT commit_sha    AS "commitSha",
           path,
           area,
           language,
           kind,
           symbol,
           parent_symbol AS "parentSymbol",
           start_line    AS "startLine",
           end_line      AS "endLine",
           content,
           content_hash  AS "contentHash",
           imports,
           claude_md     AS "claudeMd",
           (embedding <=> $2::vector) AS "score"
    FROM chunks
    WHERE commit_sha = $1
      AND ($3::text IS NULL OR area = $3)
      AND ($4::text IS NULL OR kind = $4)
      AND ($5::text IS NULL OR language = $5)
    ORDER BY embedding <=> $2::vector ASC
    LIMIT $6
  `,

  findSymbol: `
    SELECT commit_sha    AS "commitSha",
           path,
           area,
           language,
           kind,
           symbol,
           parent_symbol AS "parentSymbol",
           start_line    AS "startLine",
           end_line      AS "endLine",
           content,
           content_hash  AS "contentHash",
           imports,
           claude_md     AS "claudeMd"
    FROM chunks
    WHERE commit_sha = $1 AND symbol = $2
    ORDER BY path, start_line
  `,

  getFileChunks: `
    SELECT commit_sha    AS "commitSha",
           path,
           area,
           language,
           kind,
           symbol,
           parent_symbol AS "parentSymbol",
           start_line    AS "startLine",
           end_line      AS "endLine",
           content,
           content_hash  AS "contentHash",
           imports,
           claude_md     AS "claudeMd"
    FROM chunks
    WHERE commit_sha = $1 AND path = $2
    ORDER BY start_line
  `,
};

export class PgReaderRepositoryImpl implements PgReaderRepository {
  async getLatestAppliedMigration(conn: DbConnection): Promise<string | null> {
    try {
      const result = await conn.query<{ script_name: string }>(SQL.latestMigration);
      const first = result.rows[0];
      return first?.script_name ?? null;
    } catch {
      // schema_versions table doesn't exist yet — interpret as "no migrations applied".
      return null;
    }
  }

  async latestCommitFor(
    conn: DbConnection,
    branch: string,
    repository: string | null,
  ): Promise<CommitRow | null> {
    const result = await conn.query<CommitRow>(SQL.latestCommitFor, [branch, repository]);
    return result.rows[0] ?? null;
  }

  async listCommits(
    conn: DbConnection,
    branch: string | null,
    repository: string | null,
    limit: number,
  ): Promise<CommitRow[]> {
    const result = await conn.query<CommitRow>(SQL.listCommits, [branch, repository, limit]);
    return result.rows;
  }

  async searchByEmbedding(
    conn: DbConnection,
    commitSha: string,
    embedding: number[],
    k: number,
    filters: SearchFilters,
  ): Promise<ChunkRow[]> {
    const result = await conn.query<ChunkRow>(SQL.searchByEmbedding, [
      commitSha,
      toVectorLiteral(embedding),
      filters.area ?? null,
      filters.kind ?? null,
      filters.language ?? null,
      k,
    ]);
    return result.rows;
  }

  async findSymbol(conn: DbConnection, commitSha: string, name: string): Promise<ChunkRow[]> {
    const result = await conn.query<ChunkRow>(SQL.findSymbol, [commitSha, name]);
    return result.rows;
  }

  async getFileChunks(conn: DbConnection, commitSha: string, path: string): Promise<ChunkRow[]> {
    const result = await conn.query<ChunkRow>(SQL.getFileChunks, [commitSha, path]);
    return result.rows;
  }
}

function toVectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}
