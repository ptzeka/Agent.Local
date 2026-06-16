// a generic VectorRecord mapped back into the code-shaped fields the tools format
export interface ChunkRow {
  commitSha: string;
  path: string;
  area: string;
  language: string;
  kind: string;
  symbol: string | null;
  parentSymbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  imports: string[];
  claudeMd: string[];
  score?: number;
}

// the locate tier: a ChunkRow without its content (and contentHash for change detection), enough to
// cite and decide which chunks to expand. maps a generic VectorSummary back into code-shaped fields
export interface ChunkSummary {
  commitSha: string;
  path: string;
  area: string;
  language: string;
  kind: string;
  symbol: string | null;
  parentSymbol: string | null;
  startLine: number;
  endLine: number;
  contentHash: string;
  score?: number;
}

// code-only typed wrapper over the generic MetadataFilter; undefined means "any"
export interface SearchFilters {
  area?: string;
  kind?: string;
  language?: string;
}
