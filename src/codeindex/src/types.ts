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
