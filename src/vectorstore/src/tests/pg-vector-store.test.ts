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

  it("searches with namespace, jsonb filter, vector literal and k, mapping rows to embedding-free hits", async () => {
    const factory = new FakeFactory();
    factory.conn.rows = [
      { id: "a", namespace: "ns", content: "c", metadata: { kind: "core" }, score: 0.25 },
    ];
    const store = new PgVectorStore(factory);

    const hits = await store.searchByEmbedding("ns", [1, 2, 3], 5, { kind: "core" });

    const call = factory.conn.calls.at(-1)!;
    // the read path never projects the stored vector back — only the score expression touches it
    expect(call.sql).not.toContain("embedding::text");
    expect(call.params).toEqual(["ns", JSON.stringify({ kind: "core" }), "[1,2,3]", 5]);
    expect(hits).toEqual([
      { record: { id: "a", namespace: "ns", content: "c", metadata: { kind: "core" } }, score: 0.25 },
    ]);
  });

  it("lists by namespace + jsonb filter, mapping rows to embedding-free records", async () => {
    const factory = new FakeFactory();
    factory.conn.rows = [{ id: "a", namespace: "ns", content: "c", metadata: { symbol: "main" } }];
    const store = new PgVectorStore(factory);

    const records = await store.list("ns", { symbol: "main" });

    const call = factory.conn.calls.at(-1)!;
    expect(call.sql).toContain("metadata @> $2::jsonb");
    expect(call.sql).not.toContain("<=>");
    expect(call.sql).not.toContain("embedding");
    expect(call.params).toEqual(["ns", JSON.stringify({ symbol: "main" })]);
    expect(records).toEqual([{ id: "a", namespace: "ns", content: "c", metadata: { symbol: "main" } }]);
  });

  it("appends a LIMIT clause and param to list when a limit is given", async () => {
    const factory = new FakeFactory();
    const store = new PgVectorStore(factory);

    await store.list("ns", { symbol: "main" }, 10);

    const call = factory.conn.calls.at(-1)!;
    expect(call.sql).toContain("LIMIT $3");
    expect(call.params).toEqual(["ns", JSON.stringify({ symbol: "main" }), 10]);
  });

  it("searchSummaries selects no content or embedding and maps rows to summary hits", async () => {
    const factory = new FakeFactory();
    factory.conn.rows = [{ id: "a", namespace: "ns", metadata: { kind: "core" }, score: 0.5 }];
    const store = new PgVectorStore(factory);

    const hits = await store.searchSummaries("ns", [1, 2, 3], 5, { kind: "core" });

    const call = factory.conn.calls.at(-1)!;
    expect(call.sql).not.toContain("content");
    expect(call.sql).not.toContain("embedding::text");
    expect(hits).toEqual([{ summary: { id: "a", namespace: "ns", metadata: { kind: "core" } }, score: 0.5 }]);
  });

  it("listSummaries selects only id/namespace/metadata and honors a limit", async () => {
    const factory = new FakeFactory();
    factory.conn.rows = [{ id: "a", namespace: "ns", metadata: { symbol: "main" } }];
    const store = new PgVectorStore(factory);

    const summaries = await store.listSummaries("ns", { symbol: "main" }, 3);

    const call = factory.conn.calls.at(-1)!;
    expect(call.sql).not.toContain("content");
    expect(call.sql).toContain("LIMIT $3");
    expect(call.params).toEqual(["ns", JSON.stringify({ symbol: "main" }), 3]);
    expect(summaries).toEqual([{ id: "a", namespace: "ns", metadata: { symbol: "main" } }]);
  });

  it("relatedTo seeds the search from the stored vector and excludes the seed id", async () => {
    const factory = new FakeFactory();
    factory.conn.rows = [{ id: "b", namespace: "ns", content: "c", metadata: {}, score: 0.1 }];
    const store = new PgVectorStore(factory);

    const hits = await store.relatedTo("ns", "a", 5, { area: "api" });

    const call = factory.conn.calls.at(-1)!;
    // the seed vector is read server-side via the CTE, never marshalled as a param
    expect(call.sql).toContain("WITH seed AS");
    expect(call.sql).toContain("t.id <> $2");
    expect(call.sql).not.toContain("embedding::text");
    expect(call.params).toEqual(["ns", "a", JSON.stringify({ area: "api" }), 5]);
    expect(hits).toEqual([
      { record: { id: "b", namespace: "ns", content: "c", metadata: {} }, score: 0.1 },
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
