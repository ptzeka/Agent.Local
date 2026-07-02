import type {
  IVectorStore,
  MetadataFilter,
  RetrievedRecord,
  VectorSummary,
} from '@agent-local/vectorstore';
import type { ChunkRow, ChunkSummary, SearchFilters } from './types.js';

// the chunk record id convention, mirrored from codeindex publish.ts (toRecord): `${path}#${startLine}-${endLine}`.
// the reader rebuilds it from a citation's path + line range so callers never handle raw record ids
export function chunkRecordId(path: string, startLine: number, endLine: number): string {
  return `${path}#${startLine}-${endLine}`;
}

// the retrieval contract over the shared vector store: chunk ops map generic VectorRecords back
// into code-shaped ChunkRows, keeping codemcp ignorant of the backend behind IVectorStore
// search_code ranks by embedding; get_symbol/get_file_context are exact-match list() reads
export class CodeRetrieval {
  constructor(private readonly store: IVectorStore) {}

  async searchByEmbedding(
    commitSha: string,
    embedding: number[],
    k: number,
    filters: SearchFilters,
  ): Promise<ChunkRow[]> {
    const hits = await this.store.searchByEmbedding(commitSha, embedding, k, toFilter(filters));
    return hits.map(hit => toChunkRow(hit.record, hit.score));
  }

  async findSymbol(commitSha: string, name: string): Promise<ChunkRow[]> {
    const records = await this.store.list(commitSha, { symbol: name });
    return records
      .map(record => toChunkRow(record))
      .sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
  }

  async getFileChunks(commitSha: string, path: string): Promise<ChunkRow[]> {
    const records = await this.store.list(commitSha, { path });
    return records.map(record => toChunkRow(record)).sort((a, b) => a.startLine - b.startLine);
  }

  // semantic more-like-this: chunks nearest the given chunk's stored vector, excluding itself.
  // pure similarity from the store — structural/hybrid relatedness (imports, parentSymbol, MMR) layers here later
  async relatedTo(
    commitSha: string,
    chunkId: string,
    k: number,
    filters: SearchFilters = {},
  ): Promise<ChunkRow[]> {
    const hits = await this.store.relatedTo(commitSha, chunkId, k, toFilter(filters));
    return hits.map(hit => toChunkRow(hit.record, hit.score));
  }

  // locate tier: ranked summaries (no content) for cheap discovery before expanding the chosen few
  async locate(
    commitSha: string,
    embedding: number[],
    k: number,
    filters: SearchFilters = {},
  ): Promise<ChunkSummary[]> {
    const hits = await this.store.searchSummaries(commitSha, embedding, k, toFilter(filters));
    return hits.map(hit => toChunkSummary(hit.summary, hit.score));
  }

  // locate tier, exact-match: content-free summaries for every definition of a symbol
  async findSymbolSummaries(commitSha: string, name: string, limit?: number): Promise<ChunkSummary[]> {
    const summaries = await this.store.listSummaries(commitSha, { symbol: name }, limit);
    return summaries
      .map(summary => toChunkSummary(summary))
      .sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
  }

  // locate tier, exact-match: content-free summaries for every chunk in a file
  async getFileSummaries(commitSha: string, path: string, limit?: number): Promise<ChunkSummary[]> {
    const summaries = await this.store.listSummaries(commitSha, { path }, limit);
    return summaries.map(summary => toChunkSummary(summary)).sort((a, b) => a.startLine - b.startLine);
  }

  // expand tier: the full chunk (with content) behind a citation, or null if the id is not indexed
  async getChunk(commitSha: string, chunkId: string): Promise<ChunkRow | null> {
    const record = await this.store.get(commitSha, chunkId);
    return record ? toChunkRow(record) : null;
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}

// only the defined keys enter the equality filter, preserving the old "NULL = any" filter semantics
function toFilter(filters: SearchFilters): MetadataFilter {
  const filter: MetadataFilter = {};
  if (filters.area !== undefined) filter.area = filters.area;
  if (filters.kind !== undefined) filter.kind = filters.kind;
  if (filters.language !== undefined) filter.language = filters.language;
  return filter;
}

// codeindex writes the code fields into the record's opaque metadata (see codeindex publish.ts)
function toChunkRow(record: RetrievedRecord, score?: number): ChunkRow {
  const m = record.metadata;
  const row: ChunkRow = {
    commitSha: record.namespace,
    path: asString(m.path),
    area: asString(m.area),
    language: asString(m.language),
    kind: asString(m.kind),
    symbol: (m.symbol as string | null | undefined) ?? null,
    parentSymbol: (m.parentSymbol as string | null | undefined) ?? null,
    startLine: Number(m.startLine ?? 0),
    endLine: Number(m.endLine ?? 0),
    content: record.content,
    contentHash: asString(m.contentHash),
    imports: Array.isArray(m.imports) ? (m.imports as string[]) : [],
    claudeMd: Array.isArray(m.claudeMd) ? (m.claudeMd as string[]) : [],
  };
  if (score !== undefined) row.score = score;
  return row;
}

// the locate-tier projection: the same code fields minus content (a VectorSummary carries no content)
function toChunkSummary(summary: VectorSummary, score?: number): ChunkSummary {
  const m = summary.metadata;
  const row: ChunkSummary = {
    commitSha: summary.namespace,
    path: asString(m.path),
    area: asString(m.area),
    language: asString(m.language),
    kind: asString(m.kind),
    symbol: (m.symbol as string | null | undefined) ?? null,
    parentSymbol: (m.parentSymbol as string | null | undefined) ?? null,
    startLine: Number(m.startLine ?? 0),
    endLine: Number(m.endLine ?? 0),
    contentHash: asString(m.contentHash),
  };
  if (score !== undefined) row.score = score;
  return row;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
