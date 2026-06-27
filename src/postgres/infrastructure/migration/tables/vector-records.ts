import type { PgTableSpec } from "../dbup.js";

// shared shape for a pgvector-backed store (the @agent-local/vectorstore VectorRecord). One configurable
// factory rather than two near-duplicate specs: the only differences are the schema and the embedding
// dimension. Dimension is PINNED per table — an unpinned VECTOR cannot carry an hnsw index, so each
// service's table fixes its own width and gets exact-and-indexable cosine search.
export function vectorRecordsTable(schema: string, embedDim: number): PgTableSpec {
  return {
    schema,
    name: "vector_records",
    columns: [
      { name: "namespace", type: "TEXT", constraints: "NOT NULL" },
      { name: "id", type: "TEXT", constraints: "NOT NULL" },
      { name: "content", type: "TEXT", constraints: "NOT NULL" },
      { name: "embedding", type: `VECTOR(${embedDim})`, constraints: "NOT NULL" },
      { name: "metadata", type: "JSONB", constraints: "NOT NULL DEFAULT '{}'::jsonb" },
    ],
    primaryKey: ["namespace", "id"],
    indexes: [
      // hnsw cosine index: turns searchByEmbedding/relatedTo from a full seq-scan into ANN
      { name: `${schema}_vector_records_embedding_idx`, using: "hnsw", columns: "embedding vector_cosine_ops" },
      // gin index backs the metadata @> filter used by every search/list path
      { name: `${schema}_vector_records_metadata_idx`, using: "gin", columns: "metadata jsonb_path_ops" },
    ],
  };
}
