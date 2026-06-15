import { describe, it, expect } from "@jest/globals";
import {
  PgVectorStore,
  type DbConnection,
  type DbConnectionFactory,
  type QueryResult,
} from "@agent-local/vectorstore";

// records every SQL call so tests can assert on the marshalled params without a live Postgres
class FakeConnection implements DbConnection {
  readonly calls: { sql: string; params: unknown[] }[] = [];
  rows: unknown[] = [];

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    this.calls.push({ sql, params });
    return { rows: this.rows as T[], rowCount: this.rows.length };
  }
  async begin(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
  async [Symbol.asyncDispose](): Promise<void> {}
}

class FakeFactory implements DbConnectionFactory {
  readonly conn = new FakeConnection();
  async getConnection(): Promise<DbConnection> {
    return this.conn;
  }
  async withTransaction<T>(fn: (conn: DbConnection) => Promise<T>): Promise<T> {
    return fn(this.conn);
  }
  async end(): Promise<void> {}
}

describe("PgVectorStore SQL marshalling", () => {
  it("rejects a table name that is not a bare identifier", () => {
    expect(() => new PgVectorStore(new FakeFactory(), { table: "recs; DROP TABLE x" })).toThrow(
      /Invalid table name/,
    );
  });

  it("upserts with a vector literal and jsonb metadata via ON CONFLICT", async () => {
    const factory = new FakeFactory();
    const store = new PgVectorStore(factory, { table: "recs" });

    await store.upsert([
      { id: "a", namespace: "ns", content: "c", embedding: [1, 2, 3], metadata: { kind: "core" } },
    ]);

    const call = factory.conn.calls.at(-1)!;
    expect(call.sql).toContain("INSERT INTO recs");
    expect(call.sql).toContain("ON CONFLICT");
    expect(call.params).toEqual(["ns", "a", "c", "[1,2,3]", JSON.stringify({ kind: "core" })]);
  });

  it("searches with namespace, jsonb filter, vector literal and k, mapping rows to hits", async () => {
    const factory = new FakeFactory();
    factory.conn.rows = [
      { id: "a", namespace: "ns", content: "c", embedding: "[1,2,3]", metadata: { kind: "core" }, score: 0.25 },
    ];
    const store = new PgVectorStore(factory);

    const hits = await store.searchByEmbedding("ns", [1, 2, 3], 5, { kind: "core" });

    expect(factory.conn.calls.at(-1)!.params).toEqual([
      "ns",
      JSON.stringify({ kind: "core" }),
      "[1,2,3]",
      5,
    ]);
    expect(hits).toEqual([
      {
        record: { id: "a", namespace: "ns", content: "c", embedding: [1, 2, 3], metadata: { kind: "core" } },
        score: 0.25,
      },
    ]);
  });

  it("parses the embedding text column back into numbers on get", async () => {
    const factory = new FakeFactory();
    factory.conn.rows = [
      { id: "a", namespace: "ns", content: "c", embedding: "[0.5,-1,2]", metadata: {} },
    ];
    const store = new PgVectorStore(factory);

    expect((await store.get("ns", "a"))?.embedding).toEqual([0.5, -1, 2]);
  });

  it("returns null from get when no row matches", async () => {
    const store = new PgVectorStore(new FakeFactory());
    expect(await store.get("ns", "missing")).toBeNull();
  });
});
