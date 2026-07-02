export type ChunkKind =
  | 'class'
  | 'method'
  | 'function'
  | 'component'
  | 'interface'
  | 'record'
  | 'section'
  | 'statement'
  | 'message'
  | 'service'
  | 'rpc'
  | 'file'
  | 'window'
  | 'module';   // file-level glue (imports, top-level consts, tail) — fills the gaps between symbol chunks so the index covers every line.

export type Area = 'api' | 'backend' | 'frontend' | 'db' | 'test' | 'docs' | 'tools' | 'pipeline' | 'minikube' | 'root';

export interface CommitRow {
  commitSha: string;
  branch: string;
  repository: string;
  indexedAt?: Date;
  embedModel: string;
  embedDim: number;
  fileCount: number;
  chunkCount: number;
}

export interface RawChunk {
  path: string;
  area: Area;
  language: string;
  kind: ChunkKind;
  symbol: string | null;
  parentSymbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
  imports: string[];
}

export type EdgeType = 'imports' | 'calls' | 'implements' | 'extends';

// one relationship fact, published per commit as edges.jsonl. Endpoints are stable
// entity ids — `<path>` (file), `<path>#Symbol`, `<path>#Class.method`, `external:<module>`,
// `unresolved:<name>` — never line ranges, so edges stay joinable across snapshots
export interface CodeEdge {
  from: string;
  to: string;
  type: EdgeType;
  line: number;
}
