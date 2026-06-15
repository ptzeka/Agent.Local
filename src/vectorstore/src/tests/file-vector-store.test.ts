import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileVectorStore, type VectorRecord } from "@agent-local/vectorstore";

function record(
  id: string,
  embedding: number[],
  overrides: Partial<VectorRecord> = {},
): VectorRecord {
  return {
    id,
    namespace: "ns",
    content: `content-${id}`,
    embedding,
    metadata: {},
    ...overrides,
  };
}

let baseDir: string;
let store: FileVectorStore;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "vectorstore-"));
  store = new FileVectorStore({ baseDir });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("FileVectorStore CRUD", () => {
  it("round-trips a record through upsert and get", async () => {
    const rec = record("a", [1, 0, 0], { content: "hello", metadata: { kind: "core" } });
    await store.upsert([rec]);
    expect(await store.get("ns", "a")).toEqual(rec);
  });

  it("returns null for a missing id", async () => {
    expect(await store.get("ns", "nope")).toBeNull();
  });

  it("upsert on the same id keeps the latest version", async () => {
    await store.upsert([record("a", [1, 0, 0], { content: "v1" })]);
    await store.upsert([record("a", [0, 1, 0], { content: "v2" })]);
    const got = await store.get("ns", "a");
    expect(got?.content).toBe("v2");
    expect(got?.embedding).toEqual([0, 1, 0]);
  });

  it("delete removes a record and compacts the rest", async () => {
    await store.upsert([record("a", [1, 0, 0]), record("b", [0, 1, 0])]);
    await store.delete("ns", ["a"]);
    expect(await store.get("ns", "a")).toBeNull();
    expect(await store.get("ns", "b")).not.toBeNull();
  });
});

describe("FileVectorStore search", () => {
  beforeEach(async () => {
    await store.upsert([
      record("x", [1, 0, 0]),
      record("y", [0.9, 0.1, 0]),
      record("z", [0, 0, 1]),
    ]);
  });

  it("ranks hits by cosine closeness to the query", async () => {
    const hits = await store.searchByEmbedding("ns", [1, 0, 0], 3);
    expect(hits.map(h => h.record.id)).toEqual(["x", "y", "z"]);
    expect(hits[0]!.score).toBeCloseTo(0, 6);
  });

  it("limits results to k", async () => {
    const hits = await store.searchByEmbedding("ns", [1, 0, 0], 2);
    expect(hits).toHaveLength(2);
    expect(hits.map(h => h.record.id)).toEqual(["x", "y"]);
  });

  it("applies a metadata equality filter", async () => {
    await store.upsert([
      record("p", [1, 0, 0], { metadata: { kind: "archival" } }),
      record("q", [1, 0, 0], { metadata: { kind: "core" } }),
    ]);
    const hits = await store.searchByEmbedding("ns", [1, 0, 0], 10, { kind: "core" });
    expect(hits.map(h => h.record.id)).toEqual(["q"]);
  });
});

describe("FileVectorStore list", () => {
  beforeEach(async () => {
    await store.upsert([
      record("a", [1, 0, 0], { metadata: { symbol: "main", path: "a.ts" } }),
      record("b", [0, 1, 0], { metadata: { symbol: "main", path: "b.ts" } }),
      record("c", [0, 0, 1], { metadata: { symbol: "other", path: "a.ts" } }),
    ]);
  });

  it("returns every record in the namespace with an empty filter", async () => {
    const all = await store.list("ns");
    expect(all.map(r => r.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("returns all matches for a metadata filter, unbounded by k", async () => {
    const bySymbol = await store.list("ns", { symbol: "main" });
    expect(bySymbol.map(r => r.id).sort()).toEqual(["a", "b"]);
    const byPath = await store.list("ns", { path: "a.ts" });
    expect(byPath.map(r => r.id).sort()).toEqual(["a", "c"]);
  });

  it("returns an empty array for an unknown namespace", async () => {
    expect(await store.list("missing")).toEqual([]);
  });
});

describe("FileVectorStore namespace isolation", () => {
  it("never returns another namespace's records", async () => {
    await store.upsert([record("a", [1, 0, 0], { namespace: "alpha" })]);
    await store.upsert([record("b", [1, 0, 0], { namespace: "beta" })]);

    const hits = await store.searchByEmbedding("alpha", [1, 0, 0], 10);
    expect(hits.map(h => h.record.id)).toEqual(["a"]);
    expect(await store.get("beta", "a")).toBeNull();
  });

  it("lists every namespace that has records, decoded", async () => {
    await store.upsert([record("a", [1, 0, 0], { namespace: "user:alice" })]);
    await store.upsert([record("b", [1, 0, 0], { namespace: "user:bob" })]);
    expect(await store.listNamespaces()).toEqual(["user:alice", "user:bob"]);
  });

  it("deleteNamespace drops the whole collection", async () => {
    await store.upsert([record("a", [1, 0, 0], { namespace: "doomed" })]);
    await store.deleteNamespace("doomed");
    expect(await store.listNamespaces()).toEqual([]);
  });
});

describe("FileVectorStore layout", () => {
  it("honors partitionDir and recordsFile for byte-compatible layouts", async () => {
    const memStore = new FileVectorStore({
      baseDir,
      partitionDir: "memories",
      recordsFile: "records.jsonl",
    });
    await memStore.upsert([record("m", [1, 0, 0], { namespace: "team" })]);
    expect(existsSync(join(baseDir, "memories", "team", "records.jsonl"))).toBe(true);
  });
});
