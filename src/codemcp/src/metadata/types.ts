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

// the commit/snapshot sidecar the vector store stays ignorant of: branch->commit resolution,
// the migration journal, and snapshot stats. connection/file access is owned by the impl,
// so callers never hold a DbConnection
export interface IMetadataRepository {
  getLatestAppliedMigration(): Promise<string | null>;
  listCommits(
    branch: string | null,
    repository: string | null,
    limit: number,
  ): Promise<CommitRow[]>;
  close(): Promise<void>;
}
