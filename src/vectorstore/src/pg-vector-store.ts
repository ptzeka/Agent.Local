import type { DbConnectionFactory } from './db-types.js';
import { PgConnectionFactory } from './pg-connection.js';
import type { IVectorStore, MetadataFilter, SearchHit, VectorRecord } from './vector-store.js';

export interface PgVectorStoreOptions {
  table?: string;
}

const DEFAULT_TABLE = 'vector_records';

interface StoredRow {
  id: string;
  namespace: string;
  content: string;
  embedding: string;
  metadata: Record<string, unknown>;
}

// pgvector-backed store: exact cosine search via the `<=>` operator, metadata equality via jsonb `@>`
// dim stays unpinned here so any namespace's vector width is accepted — the consumer guards dim per namespace
export class PgVectorStore implements IVectorStore {
  private readonly factory: DbConnectionFactory;
  private readonly table: string;

  // accepts a connection string or a ready factory so consumers can share one pool across stores
  constructor(connection: string | DbConnectionFactory, options: PgVectorStoreOptions = {}) {
    this.table = options.table ?? DEFAULT_TABLE;
    // interpolated into SQL, so it must be a bare identifier — reject anything that could inject
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.table)) {
      throw new Error(`Invalid table name: ${this.table}`);
    }
    this.factory = typeof connection === 'string' ? new PgConnectionFactory(connection) : connection;
  }

  async ensureSchema(): Promise<void> {
    await this.factory.withTransaction(async conn => {
      await conn.query('CREATE EXTENSION IF NOT EXISTS vector');
      await conn.query(
        `CREATE TABLE IF NOT EXISTS ${this.table} (
           namespace TEXT  NOT NULL,
           id        TEXT  NOT NULL,
           content   TEXT  NOT NULL,
           embedding VECTOR NOT NULL,
           metadata  JSONB NOT NULL DEFAULT '{}'::jsonb,
           PRIMARY KEY (namespace, id)
         )`,
      );
    });
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.factory.withTransaction(async conn => {
      for (const r of records) {
        await conn.query(
          `INSERT INTO ${this.table} (namespace, id, content, embedding, metadata)
           VALUES ($1, $2, $3, $4::vector, $5::jsonb)
           ON CONFLICT (namespace, id) DO UPDATE
             SET content = EXCLUDED.content,
                 embedding = EXCLUDED.embedding,
                 metadata = EXCLUDED.metadata`,
          [r.namespace, r.id, r.content, toVectorLiteral(r.embedding), JSON.stringify(r.metadata)],
        );
      }
    });
  }

  async get(namespace: string, id: string): Promise<VectorRecord | null> {
    await using conn = await this.factory.getConnection();
    const result = await conn.query<StoredRow>(
      `SELECT id, namespace, content, embedding::text AS embedding, metadata
       FROM ${this.table}
       WHERE namespace = $1 AND id = $2`,
      [namespace, id],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async searchByEmbedding(
    namespace: string,
    embedding: number[],
    k: number,
    filter: MetadataFilter = {},
  ): Promise<SearchHit[]> {
    await using conn = await this.factory.getConnection();
    const result = await conn.query<StoredRow & { score: number }>(
      `SELECT id, namespace, content, embedding::text AS embedding, metadata,
              (embedding <=> $3::vector) AS score
       FROM ${this.table}
       WHERE namespace = $1 AND metadata @> $2::jsonb
       ORDER BY embedding <=> $3::vector ASC
       LIMIT $4`,
      [namespace, JSON.stringify(filter), toVectorLiteral(embedding), k],
    );
    return result.rows.map(row => ({ record: toRecord(row), score: Number(row.score) }));
  }

  async delete(namespace: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await using conn = await this.factory.getConnection();
    await conn.query(`DELETE FROM ${this.table} WHERE namespace = $1 AND id = ANY($2)`, [
      namespace,
      ids,
    ]);
  }

  async deleteNamespace(namespace: string): Promise<void> {
    await using conn = await this.factory.getConnection();
    await conn.query(`DELETE FROM ${this.table} WHERE namespace = $1`, [namespace]);
  }

  async listNamespaces(): Promise<string[]> {
    await using conn = await this.factory.getConnection();
    const result = await conn.query<{ namespace: string }>(
      `SELECT DISTINCT namespace FROM ${this.table} ORDER BY namespace`,
    );
    return result.rows.map(r => r.namespace);
  }

  async close(): Promise<void> {
    await this.factory.end();
  }
}

function toRecord(row: StoredRow): VectorRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    content: row.content,
    embedding: parseVectorLiteral(row.embedding),
    metadata: row.metadata ?? {},
  };
}

function toVectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

function parseVectorLiteral(literal: string): number[] {
  const inner = literal.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (inner.length === 0) return [];
  return inner.split(',').map(Number);
}
