import type { IVectorStore, MetadataFilter, VectorRecord } from '@agent-local/vectorstore';
import type { ChunkRow, SearchFilters } from './types.js';

// the retrieval contract over the shared vector store: chunk ops map generic VectorRecords back
// into code-shaped ChunkRows, keeping codemcp ignorant of the backend behind IVectorStore
// search_code ranks by embedding; find_symbol/get_file_context are exact-match list() reads
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
function toChunkRow(record: VectorRecord, score?: number): ChunkRow {
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

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
