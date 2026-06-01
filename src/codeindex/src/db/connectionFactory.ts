import pg from 'pg';
import type { DbConnection, DbConnectionFactory, QueryResult } from './types.js';

const { Pool } = pg;

type TxState = 'none' | 'open' | 'committed' | 'rolledback';

class PgConnection implements DbConnection {
  private txState: TxState = 'none';
  private released = false;

  constructor(private readonly client: pg.PoolClient) {}

  async query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    if (this.released) throw new Error('DbConnection used after dispose');
    const result = await this.client.query(sql, params as unknown[] | undefined);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  async begin(): Promise<void> {
    if (this.txState === 'open') throw new Error('Transaction already open');
    await this.client.query('BEGIN');
    this.txState = 'open';
  }

  async commit(): Promise<void> {
    if (this.txState !== 'open') throw new Error('No transaction to commit');
    await this.client.query('COMMIT');
    this.txState = 'committed';
  }

  async rollback(): Promise<void> {
    if (this.txState !== 'open') return;
    await this.client.query('ROLLBACK');
    this.txState = 'rolledback';
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.released) return;
    try {
      if (this.txState === 'open') {
        // Fail-safe: an open transaction at dispose means the caller never committed.
        try { await this.client.query('ROLLBACK'); } catch { /* swallow */ }
        this.txState = 'rolledback';
      }
    } finally {
      this.released = true;
      this.client.release();
    }
  }
}

export class PgConnectionFactory implements DbConnectionFactory {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async getConnection(): Promise<DbConnection> {
    const client = await this.pool.connect();
    return new PgConnection(client);
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
    await this.pool.end();
  }
}
