import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DbConnection, DbConnectionFactory, QueryResult } from '../types.js';

/**
 * File-backed connection used by the debug/file repository. Satisfies the
 * DbConnection contract so the same repository interfaces and call sites
 * (await using, withTransaction, etc.) work unchanged. SQL execution is
 * unsupported — repositories using this connection do their own file I/O
 * keyed off `connection.baseDir`.
 */
export class FileConnection implements DbConnection {
  private released = false;
  private txOpen = false;

  constructor(readonly baseDir: string) {}

  async query<T = unknown>(_sql: string, _params?: unknown[]): Promise<QueryResult<T>> {
    throw new Error(
      'FileConnection.query() is not supported. The file backend has no SQL ' +
      'engine; repositories must use their own file-based access.',
    );
  }

  async begin(): Promise<void> {
    // File backend is not transactional. begin/commit/rollback are no-ops so
    // higher-level code (withTransaction, migration runner script-per-tx) can
    // run unchanged. If a write fails partway through, the on-disk artifacts
    // may be partially written — for debug usage, re-run the publish.
    if (this.txOpen) throw new Error('Transaction already open');
    this.txOpen = true;
  }

  async commit(): Promise<void> {
    if (!this.txOpen) throw new Error('No transaction to commit');
    this.txOpen = false;
  }

  async rollback(): Promise<void> {
    this.txOpen = false;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.released = true;
    this.txOpen = false;
  }

  ensureAlive(): void {
    if (this.released) throw new Error('FileConnection used after dispose');
  }
}

export class FileConnectionFactory implements DbConnectionFactory {
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  async getConnection(): Promise<DbConnection> {
    return new FileConnection(this.baseDir);
  }

  async withTransaction<T>(fn: (conn: DbConnection) => Promise<T>): Promise<T> {
    await using conn = await this.getConnection();
    await conn.begin();
    try {
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  async end(): Promise<void> {
    // No pool to drain.
  }
}
