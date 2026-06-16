// memory semantics are metadata conventions owned by memomcp; the vectorstore stays generic.
// settled 2026-06-14 (BACKLOG "Memory record shape"): a memory is a flat VectorRecord,
// associations are a separate sidecar — never an inline field here.

// core = small/high-salience, always loaded by id on recall; archival = the bulk, retrieved top-k by similarity
export type MemoryKind = 'core' | 'archival';

// what a caller supplies to remember a memory; everything but content is an optional metadata convention
export interface MemoryInput {
  content: string;
  kind?: MemoryKind;
  category?: string;
  tags?: string[];
  tenant?: string;
  source?: string;
  // the memory's OWN id: supply to overwrite an existing memory (upsert by memory id), omit to mint a fresh one.
  // distinct from the vectorId — see RecalledMemory; a memory's id is stable, its vector record is a separate thing
  id?: string;
}

// the metadata block stored on every memory record; equality filters key off category/tenant
export interface MemoryMetadata {
  // the owning memory's id, carried by the VectorRecord so a record resolves back to its memory.
  // a memory (id) and its vector record (VectorRecord.id) are separate entities, 1:1 today; this is the back-reference
  memoryId: string;
  kind: MemoryKind;
  createdAt: string;
  category?: string;
  tags?: string[];
  tenant?: string;
  source?: string;
}

// scalar dimensions a recall can narrow on; tags stay stored-only (array equality is too brittle to filter on)
export interface RecallFilter {
  category?: string;
  tenant?: string;
}

export interface RecallQuery extends RecallFilter {
  query: string;
  // how many archival memories to rank back; core records are always returned in full
  k: number;
  // when true, re-rank the archival candidates with the reranker before trimming to k (see IReranker).
  // off (or no reranker wired) leaves the cosine ordering untouched.
  rank?: boolean;
}

// one memory surfaced by recall; score is set only for archival hits (cosine distance, lower is closer)
export interface RecalledMemory {
  // the memory's own identity
  id: string;
  // reference to the VectorRecord holding this memory's embedding (= VectorRecord.id).
  // separate from id by design: 1:1 today, but a chunked memory would be one id with many vectorIds
  vectorId: string;
  content: string;
  metadata: MemoryMetadata;
  score?: number;
  // relevance score from the reranker (higher = more relevant), set only when recall ran with rank=true.
  // distinct from `score` (cosine distance, lower is closer) so both signals stay visible.
  rerankScore?: number;
}

// core records first (always-loaded salience), then archival ranked by similarity — see "Memory record shape"
export interface RecallResult {
  collection: string;
  core: RecalledMemory[];
  archival: RecalledMemory[];
}

// the locate-tier projection of a memory: everything RecalledMemory carries minus the content body.
// recall_locate ships these so an agent can scan what exists, then expand the chosen vectorIds.
export interface MemorySummary {
  id: string;
  vectorId: string;
  metadata: MemoryMetadata;
  score?: number;
}

// the two-tier locate result: same core/archival split as RecallResult, but content-free summaries
export interface RecallLocateResult {
  collection: string;
  core: MemorySummary[];
  archival: MemorySummary[];
}
