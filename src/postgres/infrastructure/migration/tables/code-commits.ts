import type { PgTableSpec } from "../dbup.js";

// commit/snapshot bookkeeping for codeindex (was codeindex/migrations/001_init.sql). One row per
// indexed snapshot; the chunk vectors live in code.vector_records keyed by namespace = commit_sha.
export const codeCommits: PgTableSpec = {
  schema: "code",
  name: "commits",
  columns: [
    { name: "commit_sha", type: "TEXT" },
    { name: "branch", type: "TEXT", constraints: "NOT NULL" },
    { name: "indexed_at", type: "TIMESTAMPTZ", constraints: "NOT NULL DEFAULT now()" },
    { name: "embed_model", type: "TEXT", constraints: "NOT NULL" },
    { name: "embed_dim", type: "INTEGER", constraints: "NOT NULL" },
    { name: "file_count", type: "INTEGER", constraints: "NOT NULL" },
    { name: "chunk_count", type: "INTEGER", constraints: "NOT NULL" },
  ],
  primaryKey: ["commit_sha"],
  indexes: [{ name: "commits_branch_idx", columns: "branch, indexed_at DESC" }],
};
