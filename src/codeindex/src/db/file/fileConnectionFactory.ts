import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DbConnection, DbConnectionFactory, QueryResult } from '../types.js';

// File-backed connection satisfying the DbConnection contract so repositories and call sites
// (await using, withTransaction) work unchanged; SQL is unsupported — repositories do their own
// file I/O keyed off connection.baseDir.
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
    // file backend is not transactional; begin/commit/rollback are no-ops so higher-level code runs unchanged
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
    // no pool to drain
  }
}
