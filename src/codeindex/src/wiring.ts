import {
  PgConnectionFactory,
  PgVectorStore,
  FileVectorStore,
  type DbConnectionFactory,
  type IVectorStore,
} from '@agent-local/vectorstore';
import type { CodeIndexConfig } from './config.js';
import type { CommitRepository } from './db/pgRepository.js';
import { PgCommitRepositoryImpl } from './db/pgRepository.js';
import { FileConnectionFactory } from './db/file/fileConnectionFactory.js';
import { FileCommitRepositoryImpl } from './db/file/fileRepository.js';

// code chunks are partitioned by commit sha: namespace = sha, laid out as
// data/commits/<sha>/chunks.jsonl so the file backend stays byte-compatible-ish
const PARTITION_DIR = 'commits';
const RECORDS_FILE = 'chunks.jsonl';

export interface WiredWriter {
  // generic similarity store for chunk rows (namespace = commit sha)
  vectorStore: IVectorStore;
  // commit metadata + migration journal live alongside, owned by codeindex
  factory: DbConnectionFactory;
  repo: CommitRepository;
  // Postgres-only; the migration runner uses this to apply .sql files vs. just seed the schema_versions journal
  supportsSql: boolean;
  // create the vector store's own table/dir before the first write (no-op on file)
  ensureVectorSchema(): Promise<void>;
}

export function wireWriter(config: CodeIndexConfig): WiredWriter {
  if (config.backend === 'file') {
    return {
      vectorStore: new FileVectorStore({
        baseDir: config.fileDir,
        partitionDir: PARTITION_DIR,
        recordsFile: RECORDS_FILE,
      }),
      factory: new FileConnectionFactory(config.fileDir),
      repo: new FileCommitRepositoryImpl(),
      supportsSql: false,
      ensureVectorSchema: async () => undefined,
    };
  }
  // share one pool between the vector store and the commit/migration factory; cli ends it once
  const factory = new PgConnectionFactory(config.connectionString);
  const vectorStore = new PgVectorStore(factory);
  return {
    vectorStore,
    factory,
    repo: new PgCommitRepositoryImpl(),
    supportsSql: true,
    ensureVectorSchema: () => vectorStore.ensureSchema(),
  };
}
