-- Run against the target database (agentlocal). Tables + indexes, all CREATE ... IF NOT EXISTS so the
-- whole file is idempotent. Embedding dimensions are PINNED per schema — an unpinned VECTOR cannot
-- carry an hnsw index — and match each consumer's embed provider: codemcp local=768, memomcp voyage=1024
-- (see src/codemcp/src/config.ts and src/memomcp/src/config.ts).

CREATE EXTENSION IF NOT EXISTS vector;

-- code: codeindex snapshot bookkeeping + its chunk vectors (namespace = commit_sha)
CREATE TABLE IF NOT EXISTS code.commits (
  commit_sha   TEXT PRIMARY KEY,
  branch       TEXT        NOT NULL,
  indexed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  embed_model  TEXT        NOT NULL,
  embed_dim    INTEGER     NOT NULL,
  file_count   INTEGER     NOT NULL,
  chunk_count  INTEGER     NOT NULL
);
CREATE INDEX IF NOT EXISTS commits_branch_idx ON code.commits (branch, indexed_at DESC);

CREATE TABLE IF NOT EXISTS code.vector_records (
  namespace  TEXT          NOT NULL,
  id         TEXT          NOT NULL,
  content    TEXT          NOT NULL,
  embedding  VECTOR(768)   NOT NULL,
  metadata   JSONB         NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (namespace, id)
);
-- hnsw cosine index turns searchByEmbedding/relatedTo from a seq-scan into ANN; gin backs the metadata @> filter
CREATE INDEX IF NOT EXISTS code_vector_records_embedding_idx ON code.vector_records USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS code_vector_records_metadata_idx  ON code.vector_records USING gin  (metadata jsonb_path_ops);

-- memo: memory store vectors (namespace = collection id)
CREATE TABLE IF NOT EXISTS memo.vector_records (
  namespace  TEXT          NOT NULL,
  id         TEXT          NOT NULL,
  content    TEXT          NOT NULL,
  embedding  VECTOR(1024)  NOT NULL,
  metadata   JSONB         NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (namespace, id)
);
CREATE INDEX IF NOT EXISTS memo_vector_records_embedding_idx ON memo.vector_records USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS memo_vector_records_metadata_idx  ON memo.vector_records USING gin  (metadata jsonb_path_ops);
