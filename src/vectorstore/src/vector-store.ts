// the generic record: content plus its embedding under an opaque namespace
// the store never interprets namespace or metadata — snapshot/relationship semantics live in consumers
export interface VectorRecord {
  readonly id: string;
  readonly namespace: string;
  readonly content: string;
  readonly embedding: number[];
  readonly metadata: Record<string, unknown>;
}

// score is cosine distance: lower is closer, 0 is identical
export interface SearchHit {
  readonly record: VectorRecord;
  readonly score: number;
}

// equality over metadata: every key must match the record's value (AND-ed)
export type MetadataFilter = Record<string, unknown>;

// CRUD + similarity search over VectorRecord; namespace partitions, embeddings come in already computed
// the store takes embeddings as INPUT and never embeds — that tier is @agent-local/vectorizer
export interface IVectorStore {
  upsert(records: VectorRecord[]): Promise<void>;
  get(namespace: string, id: string): Promise<VectorRecord | null>;
  searchByEmbedding(
    namespace: string,
    embedding: number[],
    k: number,
    filter?: MetadataFilter,
  ): Promise<SearchHit[]>;
  // exact-match retrieval with no embedding: every record in the namespace matching the filter
  // unbounded by design — callers that need ranking use searchByEmbedding instead
  list(namespace: string, filter?: MetadataFilter): Promise<VectorRecord[]>;
  delete(namespace: string, ids: string[]): Promise<void>;
  deleteNamespace(namespace: string): Promise<void>;
  listNamespaces(): Promise<string[]>;
  close(): Promise<void>;
}
