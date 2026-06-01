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

/**
 * Wires the primary backend reader.
 *
 * For the file backend in single-repo (legacy) mode this points to `config.fileDir`
 * (the package-root data directory). In multi-repo mode the callers should use
 * `wireMultiRepoReaders` for the per-repo readers; the primary reader returned
 * here is kept as a fallback / for Postgres usage.
 */
export function wireReader(config: CodeMcpConfig): WiredReader {
  if (config.backend === 'file') {
    // In multi-repo mode we still need a primary WiredReader for the serve()
    // shutdown path. Use the first configured repo's fileDir if available,
    // otherwise fall back to the package-root data directory (legacy).
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

/**
 * Builds a per-repository reader map for the file backend multi-repo mode.
 * Keyed by repository name (e.g. "Platform/Rxo.Platform.Web.Sandbox").
 * Each value has its own `FileConnectionFactory` pointing at
 * {@link repoFileDir} for that entry (package `data/` or `{localPath}/.codemcp/data/...`).
 */
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
