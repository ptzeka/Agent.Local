// the generic record: content plus its embedding under an opaque namespace
// the store never interprets namespace or metadata — snapshot/relationship semantics live in consumers
// embedding is WRITE-ONLY: it is supplied on upsert and returned by get (the expand path), but never
// shipped back by the search/list read paths — those return RetrievedRecord instead (see below)
export interface VectorRecord {
  readonly id: string;
  readonly namespace: string;
  readonly content: string;
  readonly embedding: number[];
  readonly metadata: Record<string, unknown>;
}

// what the search/list read paths return: the full record minus its embedding. the vector crosses the
// wire on upsert and on a deliberate get, never on a bulk read where the consumer would just discard it
export type RetrievedRecord = Omit<VectorRecord, 'embedding'>;

// the locate tier: id + namespace + metadata, no content and no embedding. enough to rank and decide
// which records to expand (via get) without hauling bodies back for candidates the caller won't quote
export interface VectorSummary {
  readonly id: string;
  readonly namespace: string;
  readonly metadata: Record<string, unknown>;
}

// score is cosine distance: lower is closer, 0 is identical
export interface SearchHit {
  readonly record: RetrievedRecord;
  readonly score: number;
}

// a ranked locate-tier hit: the summary plus its cosine distance to the query
export interface SummaryHit {
  readonly summary: VectorSummary;
  readonly score: number;
}

// equality over metadata: every key must match the record's value (AND-ed)
export type MetadataFilter = Record<string, unknown>;

// CRUD + similarity search over VectorRecord; namespace partitions, embeddings come in already computed
// the store takes embeddings as INPUT and never embeds — that tier is @agent-local/vectorizer
export interface IVectorStore {
  upsert(records: VectorRecord[]): Promise<void>;
  // the expand path: returns the full record INCLUDING its embedding
  get(namespace: string, id: string): Promise<VectorRecord | null>;
  // rank by similarity; results omit the embedding (it stayed in the store)
  searchByEmbedding(
    namespace: string,
    embedding: number[],
    k: number,
    filter?: MetadataFilter,
  ): Promise<SearchHit[]>;
  // exact-match retrieval with no ranking: every record in the namespace matching the filter, sans embedding
  // optional limit caps the rows returned; omit it for the historical unbounded behaviour
  list(namespace: string, filter?: MetadataFilter, limit?: number): Promise<RetrievedRecord[]>;
  // locate tier: same ranking as searchByEmbedding but projects away content too, returning summaries only
  searchSummaries(
    namespace: string,
    embedding: number[],
    k: number,
    filter?: MetadataFilter,
  ): Promise<SummaryHit[]>;
  // locate tier: same exact-match as list but projects away content, returning summaries only
  listSummaries(namespace: string, filter?: MetadataFilter, limit?: number): Promise<VectorSummary[]>;
  // semantic more-like-this: rank the namespace against the stored vector of `id`, excluding `id` itself.
  // pure similarity — no structural/relatedness heuristics (those compose in the consumer). the seed
  // vector is read and reused server-side, so the embedding never crosses the wire
  relatedTo(
    namespace: string,
    id: string,
    k: number,
    filter?: MetadataFilter,
  ): Promise<SearchHit[]>;
  delete(namespace: string, ids: string[]): Promise<void>;
  deleteNamespace(namespace: string): Promise<void>;
  listNamespaces(): Promise<string[]>;
  close(): Promise<void>;
}
