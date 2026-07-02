import { PgVectorStore, FileVectorStore } from '@agent-local/vectorstore';
import type { CodeMcpConfig } from './config.js';
import { repoFileDir } from './config.js';
import { CodeRetrieval } from './retrieval/codeRetrieval.js';
import type { IMetadataRepository } from './metadata/types.js';
import { PgMetadataRepository } from './metadata/pgMetadataRepository.js';
import { FileMetadataRepository } from './metadata/fileMetadataRepository.js';
import type { IEdgeRepository } from './edges/types.js';
import { FileEdgeRepository, NoEdgeRepository } from './edges/fileEdgeRepository.js';

// repo-first layout: each repository's data lives under data/<owner>/<repo>/, snapshots under
// commits/<sha>/chunks.jsonl — mirrors what codeindex publishes through the same file backend
const PARTITION_DIR = 'commits';
const RECORDS_FILE = 'chunks.jsonl';

// a backend-agnostic reader triple: chunk retrieval over the shared store, the snapshot
// sidecar, and the relationship sidecar (edges.jsonl)
export interface WiredReader {
  retrieval: CodeRetrieval;
  metadata: IMetadataRepository;
  edges: IEdgeRepository;
}

// Primary backend reader, kept as a fallback / for Postgres; multi-repo callers
// use wireMultiRepoReaders for the per-repo readers.
export function wireReader(config: CodeMcpConfig): WiredReader {
  if (config.backend === 'file') {
    // first configured repo's dir, else the package-root data dir (legacy single-repo)
    const firstRepo = config.repositories[0];
    const dir = firstRepo ? repoFileDir(firstRepo) : config.fileDir;
    return wireFileReader(dir);
  }
  return {
    retrieval: new CodeRetrieval(new PgVectorStore(config.connectionString)),
    metadata: new PgMetadataRepository(config.connectionString),
    edges: new NoEdgeRepository(),
  };
}

// per-repository file-backend readers keyed by repository name, each rooted at its own data dir
export function wireMultiRepoReaders(config: CodeMcpConfig): Map<string, WiredReader> {
  const result = new Map<string, WiredReader>();
  for (const entry of config.repositories) {
    result.set(entry.name, wireFileReader(repoFileDir(entry)));
  }
  return result;
}

function wireFileReader(dir: string): WiredReader {
  return {
    retrieval: new CodeRetrieval(
      new FileVectorStore({ baseDir: dir, partitionDir: PARTITION_DIR, recordsFile: RECORDS_FILE }),
    ),
    metadata: new FileMetadataRepository(dir),
    edges: new FileEdgeRepository(dir),
  };
}
