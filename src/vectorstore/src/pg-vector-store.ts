import type { DbConnectionFactory } from './db-types.js';
import { PgConnectionFactory } from './pg-connection.js';
import type {
  IVectorStore,
  MetadataFilter,
  RetrievedRecord,
  SearchHit,
  SummaryHit,
  VectorRecord,
  VectorSummary,
} from './vector-store.js';

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

// read-path rows omit the embedding column — it never leaves the server on a bulk read
interface RetrievedRow {
  id: string;
  namespace: string;
  content: string;
  metadata: Record<string, unknown>;
}

// locate-path rows omit content too
interface SummaryRow {
  id: string;
  namespace: string;
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
    // interpolated into SQL, so it must be a bare identifier (with an optional schema prefix, e.g.
    // "code.vector_records" for the provisioned per-service schemas) — reject anything that could inject
    if (!/^([A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*$/.test(this.table)) {
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
    // embedding stays out of the SELECT list — the read path never ships the vector back
    const result = await conn.query<RetrievedRow & { score: number }>(
      `SELECT id, namespace, content, metadata,
              (embedding <=> $3::vector) AS score
       FROM ${this.table}
       WHERE namespace = $1 AND metadata @> $2::jsonb
       ORDER BY embedding <=> $3::vector ASC
       LIMIT $4`,
      [namespace, JSON.stringify(filter), toVectorLiteral(embedding), k],
    );
    return result.rows.map(row => ({ record: toRetrieved(row), score: Number(row.score) }));
  }

  async list(
    namespace: string,
    filter: MetadataFilter = {},
    limit?: number,
  ): Promise<RetrievedRecord[]> {
    await using conn = await this.factory.getConnection();
    const limitClause = limit === undefined ? '' : ' LIMIT $3';
    const params: unknown[] = [namespace, JSON.stringify(filter)];
    if (limit !== undefined) params.push(limit);
    const result = await conn.query<RetrievedRow>(
      `SELECT id, namespace, content, metadata
       FROM ${this.table}
       WHERE namespace = $1 AND metadata @> $2::jsonb${limitClause}`,
      params,
    );
    return result.rows.map(toRetrieved);
  }

  async searchSummaries(
    namespace: string,
    embedding: number[],
    k: number,
    filter: MetadataFilter = {},
  ): Promise<SummaryHit[]> {
    await using conn = await this.factory.getConnection();
    // content stays out too — the locate tier ships only id + metadata + score
    const result = await conn.query<SummaryRow & { score: number }>(
      `SELECT id, namespace, metadata,
              (embedding <=> $3::vector) AS score
       FROM ${this.table}
       WHERE namespace = $1 AND metadata @> $2::jsonb
       ORDER BY embedding <=> $3::vector ASC
       LIMIT $4`,
      [namespace, JSON.stringify(filter), toVectorLiteral(embedding), k],
    );
    return result.rows.map(row => ({ summary: toSummary(row), score: Number(row.score) }));
  }

  async listSummaries(
    namespace: string,
    filter: MetadataFilter = {},
    limit?: number,
  ): Promise<VectorSummary[]> {
    await using conn = await this.factory.getConnection();
    const limitClause = limit === undefined ? '' : ' LIMIT $3';
    const params: unknown[] = [namespace, JSON.stringify(filter)];
    if (limit !== undefined) params.push(limit);
    const result = await conn.query<SummaryRow>(
      `SELECT id, namespace, metadata
       FROM ${this.table}
       WHERE namespace = $1 AND metadata @> $2::jsonb${limitClause}`,
      params,
    );
    return result.rows.map(toSummary);
  }

  async relatedTo(
    namespace: string,
    id: string,
    k: number,
    filter: MetadataFilter = {},
  ): Promise<SearchHit[]> {
    await using conn = await this.factory.getConnection();
    // seed the search with the stored vector of `id` via a subquery, so the embedding never crosses the
    // wire; exclude the seed itself. an empty seed (missing id) yields no rows from the cross join
    const result = await conn.query<RetrievedRow & { score: number }>(
      `WITH seed AS (
         SELECT embedding FROM ${this.table} WHERE namespace = $1 AND id = $2
       )
       SELECT t.id, t.namespace, t.content, t.metadata,
              (t.embedding <=> seed.embedding) AS score
       FROM ${this.table} t, seed
       WHERE t.namespace = $1 AND t.id <> $2 AND t.metadata @> $3::jsonb
       ORDER BY t.embedding <=> seed.embedding ASC
       LIMIT $4`,
      [namespace, id, JSON.stringify(filter), k],
    );
    return result.rows.map(row => ({ record: toRetrieved(row), score: Number(row.score) }));
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

// read shape: no embedding column was selected, so there is nothing to parse
function toRetrieved(row: RetrievedRow): RetrievedRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    content: row.content,
    metadata: row.metadata ?? {},
  };
}

// locate shape: id + namespace + metadata only
function toSummary(row: SummaryRow): VectorSummary {
  return { id: row.id, namespace: row.namespace, metadata: row.metadata ?? {} };
}

function toVectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

function parseVectorLiteral(literal: string): number[] {
  const inner = literal.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (inner.length === 0) return [];
  return inner.split(',').map(Number);
}
