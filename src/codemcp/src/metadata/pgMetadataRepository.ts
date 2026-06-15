import { PgConnectionFactory, type DbConnectionFactory } from '@agent-local/vectorstore';
import type { CommitRow, IMetadataRepository } from './types.js';

const SQL = {
  latestMigration: `
    SELECT script_name
    FROM schema_versions
    ORDER BY script_name DESC
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
};

// reads the snapshot sidecar over its own pg pool, created in the constructor and released by
// close() — tools see only IMetadataRepository, never a connection
export class PgMetadataRepository implements IMetadataRepository {
  private readonly factory: DbConnectionFactory;

  constructor(connectionString: string) {
    this.factory = new PgConnectionFactory(connectionString);
  }

  async getLatestAppliedMigration(): Promise<string | null> {
    await using conn = await this.factory.getConnection();
    try {
      const result = await conn.query<{ script_name: string }>(SQL.latestMigration);
      return result.rows[0]?.script_name ?? null;
    } catch {
      // missing schema_versions table means no migrations applied yet
      return null;
    }
  }

  async listCommits(
    branch: string | null,
    repository: string | null,
    limit: number,
  ): Promise<CommitRow[]> {
    await using conn = await this.factory.getConnection();
    const result = await conn.query<CommitRow>(SQL.listCommits, [branch, repository, limit]);
    return result.rows;
  }

  async close(): Promise<void> {
    await this.factory.end();
  }
}
