import { resolve } from 'node:path';
import type { DbConnection, DbConnectionFactory, QueryResult } from '../types.js';

/**
 * File-backed connection used by the debug/file reader repository. Mirrors
 * the codeindex writer-side FileConnection — repositories using this access
 * the disk via `connection.baseDir`. SQL execution is unsupported.
 */
export class FileConnection implements DbConnection {
  private released = false;
  private txOpen = false;

  constructor(readonly baseDir: string) {}

  async query<T = unknown>(_sql: string, _params?: unknown[]): Promise<QueryResult<T>> {
    throw new Error(
      'FileConnection.query() is not supported. The file backend has no SQL ' +
      'engine; the reader repository must use file-based access.',
    );
  }

  async begin(): Promise<void> {
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
    // Read-only backend: do not mkdir — an empty directory looks like "no migrations"
    // and breaks startup; index data must come from codeindex publish or a manual copy.
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
    // Nothing to clean up.
  }
}
