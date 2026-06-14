import type { CodeMcpConfig } from './config.js';
import { repoFileDir } from './config.js';
import type { DbConnectionFactory } from './db/types.js';
import type { PgReaderRepository } from './db/pgRepository.js';
import { PgConnectionFactory } from './db/connectionFactory.js';
import { PgReaderRepositoryImpl } from './db/pgRepository.js';
import { FileConnectionFactory } from './db/file/fileConnectionFactory.js';
import { FileReaderRepositoryImpl } from './db/file/fileRepository.js';

export interface WiredReader {
  factory: DbConnectionFactory;
  repo: PgReaderRepository;
}

// Primary backend reader, kept as a fallback / for Postgres; multi-repo callers
// use wireMultiRepoReaders for the per-repo readers.
export function wireReader(config: CodeMcpConfig): WiredReader {
  if (config.backend === 'file') {
    // first configured repo's dir, else the package-root data dir (legacy single-repo)
    const firstRepo = config.repositories[0];
    const dir = firstRepo ? repoFileDir(firstRepo) : config.fileDir;
    return {
      factory: new FileConnectionFactory(dir),
      repo: new FileReaderRepositoryImpl(),
    };
  }
  return {
    factory: new PgConnectionFactory(config.connectionString),
    repo: new PgReaderRepositoryImpl(),
  };
}

// per-repository file-backend readers keyed by repository name, each with its own connection factory
export function wireMultiRepoReaders(
  config: CodeMcpConfig,
): Map<string, WiredReader> {
  const result = new Map<string, WiredReader>();
  for (const entry of config.repositories) {
    const dir = repoFileDir(entry);
    result.set(entry.name, {
      factory: new FileConnectionFactory(dir),
      repo: new FileReaderRepositoryImpl(),
    });
  }
  return result;
}
