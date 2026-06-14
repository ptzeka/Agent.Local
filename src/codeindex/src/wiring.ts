import type { CodeIndexConfig } from './config.js';
import type { DbConnectionFactory } from './db/types.js';
import type { PgWriterRepository } from './db/pgRepository.js';
import { PgConnectionFactory } from './db/connectionFactory.js';
import { PgWriterRepositoryImpl } from './db/pgRepository.js';
import { FileConnectionFactory } from './db/file/fileConnectionFactory.js';
import { FileWriterRepositoryImpl } from './db/file/fileRepository.js';

export interface WiredWriter {
  factory: DbConnectionFactory;
  repo: PgWriterRepository;
  // Postgres-only; the migration runner uses this to apply .sql files vs. just seed the schema_versions journal
  supportsSql: boolean;
}

export function wireWriter(config: CodeIndexConfig): WiredWriter {
  if (config.backend === 'file') {
    return {
      factory: new FileConnectionFactory(config.fileDir),
      repo: new FileWriterRepositoryImpl(),
      supportsSql: false,
    };
  }
  return {
    factory: new PgConnectionFactory(config.connectionString),
    repo: new PgWriterRepositoryImpl(),
    supportsSql: true,
  };
}
