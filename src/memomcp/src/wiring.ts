import { PgVectorStore, FileVectorStore, type IVectorStore } from '@agent-local/vectorstore';
import { VectorService } from '@agent-local/vectorizer';
import type { MemoMcpConfig } from './config.js';
import { MemoryRepository } from './memory/memoryRepository.js';
import { LocalReranker } from './rerank/localReranker.js';

// memories live under data/memories/<collection>/records.jsonl, parallel to codeindex's commits/<sha>/chunks.jsonl
const PARTITION_DIR = 'memories';
const RECORDS_FILE = 'records.jsonl';

export interface Wired {
  repository: MemoryRepository;
  store: IVectorStore;
}

export function wire(config: MemoMcpConfig): Wired {
  const store = wireStore(config);
  const embedder = VectorService.fromProvider(config.embedProvider, config.embedDim);
  // local stand-in for the configured "reranker" role (models.json) until a real cross-encoder is wired
  const reranker = new LocalReranker();
  return { repository: new MemoryRepository(store, embedder, reranker), store };
}

function wireStore(config: MemoMcpConfig): IVectorStore {
  if (config.backend === 'file') {
    return new FileVectorStore({ baseDir: config.baseDir, partitionDir: PARTITION_DIR, recordsFile: RECORDS_FILE });
  }
  return new PgVectorStore(config.connectionString);
}
