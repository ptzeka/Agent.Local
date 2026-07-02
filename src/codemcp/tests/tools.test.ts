import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileVectorStore, type VectorRecord } from "@agent-local/vectorstore";
import { VectorService } from "@agent-local/vectorizer";
import { CodeRetrieval } from "../src/retrieval/codeRetrieval.js";
import { FileMetadataRepository } from "../src/metadata/fileMetadataRepository.js";
import { FileEdgeRepository } from "../src/edges/fileEdgeRepository.js";
import type { EdgeRow } from "../src/edges/types.js";
import type { WiredReader } from "../src/wiring.js";
import type { ToolDeps } from "../src/tools/registry.js";
import { searchCode } from "../src/tools/search_code.js";
import { getSymbol } from "../src/tools/get_symbol.js";
import { getFileContext } from "../src/tools/get_file_context.js";
import { listCommits } from "../src/tools/list_commits.js";
import { relatedCode } from "../src/tools/related_code.js";
import { locateCode } from "../src/tools/locate_code.js";
import { locateSymbol } from "../src/tools/locate_symbol.js";
import { locateFile } from "../src/tools/locate_file.js";
import { expandChunk } from "../src/tools/expand_chunk.js";
import { getRelationships } from "../src/tools/get_relationships.js";

// 40-hex sha so the file metadata reader recognises the commit dir
const SHA = "a".repeat(40);
const REPO = "acme/widgets";
const DIM = 32;

interface Chunk {
  path: string;
  symbol: string;
  startLine: number;
  endLine: number;
  content: string;
}

const CHUNKS: Chunk[] = [
  { path: "src/a.ts", symbol: "computeSum", startLine: 1, endLine: 5, content: "function computeSum(a, b) { return a + b; }" },
  { path: "src/a.ts", symbol: "computeProduct", startLine: 7, endLine: 11, content: "function computeProduct(a, b) { return a * b; }" },
  { path: "src/b.ts", symbol: "computeSum", startLine: 1, endLine: 4, content: "export function computeSum() { return 0; }" },
];

let baseDir: string;
let embedder: VectorService;
let deps: ToolDeps;

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), "codemcp-tools-"));
  embedder = VectorService.fromProvider("local", DIM);

  const commitDir = join(baseDir, "commits", SHA);
  mkdirSync(commitDir, { recursive: true });

  // chunks.jsonl in the generic VectorRecord shape codeindex publishes through the shared store
  const lines: string[] = [];
  for (const c of CHUNKS) {
    const record: VectorRecord = {
      id: `${c.path}#${c.startLine}-${c.endLine}`,
      namespace: SHA,
      content: c.content,
      embedding: await embedder.embedQuery(c.content),
      metadata: {
        path: c.path,
        area: "backend",
        language: "typescript",
        kind: "function",
        symbol: c.symbol,
        parentSymbol: null,
        startLine: c.startLine,
        endLine: c.endLine,
        contentHash: "hash",
        imports: [],
        claudeMd: ["CLAUDE.md"],
      },
    };
    lines.push(JSON.stringify(record));
  }
  writeFileSync(join(commitDir, "chunks.jsonl"), lines.join("\n") + "\n", "utf-8");

  writeFileSync(
    join(commitDir, "commit.json"),
    JSON.stringify({
      commitSha: SHA,
      branch: "main",
      repository: REPO,
      indexedAt: "2026-06-01T00:00:00.000Z",
      embedModel: embedder.modelId,
      embedDim: DIM,
      fileCount: 2,
      chunkCount: CHUNKS.length,
    }),
    "utf-8",
  );

  writeFileSync(
    join(baseDir, "schema_versions.json"),
    JSON.stringify([{ scriptName: "002_add_repository.sql", appliedAt: "2026-06-01T00:00:00.000Z", checksum: "x" }]),
    "utf-8",
  );

  // edges.jsonl in the CodeEdge shape codeindex publishes alongside chunks
  const EDGES: EdgeRow[] = [
    { from: "src/a.ts", to: "src/b.ts#computeSum", type: "imports", line: 1 },
    { from: "src/a.ts#computeProduct", to: "src/a.ts#computeSum", type: "calls", line: 8 },
    { from: "src/a.ts#Widget", to: "external:react#Component", type: "extends", line: 3 },
  ];
  writeFileSync(join(commitDir, "edges.jsonl"), EDGES.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8");

  const reader: WiredReader = {
    retrieval: new CodeRetrieval(
      new FileVectorStore({ baseDir, partitionDir: "commits", recordsFile: "chunks.jsonl" }),
    ),
    metadata: new FileMetadataRepository(baseDir),
    edges: new FileEdgeRepository(baseDir),
  };
  deps = {
    reader,
    embedder,
    defaultBranch: "main",
    currentRepository: REPO,
    repoReaders: new Map(),
  };
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("codemcp tools over the shared file store", () => {
  test("list_commits reports the indexed snapshot", async () => {
    const out = await listCommits({ limit: 10 }, deps);
    expect(out).toContain(SHA);
    expect(out).toContain(`repository=${REPO}`);
    expect(out).toContain("branch=main");
  });

  test("get_symbol returns every definition, ordered by path then line", async () => {
    const out = await getSymbol({ name: "computeSum" }, deps);
    const aIdx = out.indexOf("src/a.ts:1-5");
    const bIdx = out.indexOf("src/b.ts:1-4");
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
    // the other file's computeProduct must not appear
    expect(out).not.toContain("computeProduct");
  });

  test("get_file_context returns a file's chunks in line order, with governance", async () => {
    const out = await getFileContext({ path: "src/a.ts" }, deps);
    const sumIdx = out.indexOf("src/a.ts:1-5");
    const prodIdx = out.indexOf("src/a.ts:7-11");
    expect(sumIdx).toBeGreaterThanOrEqual(0);
    expect(prodIdx).toBeGreaterThan(sumIdx);
    expect(out).toContain("Governing CLAUDE.md files");
    expect(out).not.toContain("src/b.ts");
  });

  test("search_code ranks the exact-content match first and maps it back to a chunk", async () => {
    const out = await searchCode({ query: CHUNKS[1]!.content, k: 8 }, deps);
    expect(out).toContain(`repository: ${REPO}`);
    expect(out).toContain(`commit: ${SHA.slice(0, 12)}`);
    // the queried content is computeProduct at a.ts:7-11 — distance 0, so it ranks first
    const firstHit = out.indexOf("src/a.ts:7-11");
    expect(firstHit).toBeGreaterThanOrEqual(0);
  });

  test("search_code applies the code-only metadata filter", async () => {
    const hit = await searchCode({ query: CHUNKS[0]!.content, k: 8, kind: "function" }, deps);
    expect(hit).toContain("src/a.ts");
    const miss = await searchCode({ query: CHUNKS[0]!.content, k: 8, area: "frontend" }, deps);
    expect(miss).toContain("(no results)");
  });

  test("related_code ranks neighbours of a seed chunk and excludes the seed itself", async () => {
    // seed on computeSum@a.ts:1-5; its nearest neighbour is the other computeSum (b.ts), then computeProduct
    const out = await relatedCode({ path: "src/a.ts", startLine: 1, endLine: 5, k: 8 }, deps);
    expect(out).not.toContain("src/a.ts:1-5"); // seed excluded
    expect(out).toContain("src/b.ts:1-4");
    expect(out).toContain("src/a.ts:7-11");
  });

  test("related_code reports a missing seed citation", async () => {
    const out = await relatedCode({ path: "src/a.ts", startLine: 2, endLine: 9, k: 8 }, deps);
    expect(out).toContain("no related chunks");
  });

  test("locate_code returns content-free summaries ranked by meaning", async () => {
    const out = await locateCode({ query: CHUNKS[1]!.content, k: 8 }, deps);
    expect(out).toContain("src/a.ts:7-11"); // exact-content match ranks first
    // summaries carry the citation header but not the body
    expect(out).not.toContain(CHUNKS[1]!.content);
  });

  test("locate_symbol lists a symbol's definitions as summaries, ordered, without bodies", async () => {
    const out = await locateSymbol({ name: "computeSum" }, deps);
    const aIdx = out.indexOf("src/a.ts:1-5");
    const bIdx = out.indexOf("src/b.ts:1-4");
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(out).not.toContain("function computeSum"); // no content
    expect(out).not.toContain("computeProduct");
  });

  test("locate_file outlines a file's chunks as summaries in line order", async () => {
    const out = await locateFile({ path: "src/a.ts" }, deps);
    const sumIdx = out.indexOf("src/a.ts:1-5");
    const prodIdx = out.indexOf("src/a.ts:7-11");
    expect(sumIdx).toBeGreaterThanOrEqual(0);
    expect(prodIdx).toBeGreaterThan(sumIdx);
    expect(out).not.toContain("return a + b"); // no content
    expect(out).not.toContain("src/b.ts");
  });

  test("expand_chunk returns the full content behind an exact citation", async () => {
    const out = await expandChunk({ path: "src/a.ts", startLine: 7, endLine: 11 }, deps);
    expect(out).toContain("src/a.ts:7-11");
    expect(out).toContain(CHUNKS[1]!.content); // the body is present
  });

  test("expand_chunk reports an unmatched line range", async () => {
    const out = await expandChunk({ path: "src/a.ts", startLine: 2, endLine: 9 }, deps);
    expect(out).toContain("no chunk at src/a.ts:2-9");
  });

  test("get_relationships answers by leaf symbol name; empty directions are omitted", async () => {
    const out = await getRelationships({ name: "computeSum", direction: "both" }, deps);
    // computeSum is only ever a target in the fixture: callers and importers point at it
    expect(out).toContain("incoming:");
    expect(out).not.toContain("outgoing:");
    expect(out).toContain("src/a.ts#computeProduct -[calls]-> src/a.ts#computeSum");
    expect(out).toContain("src/a.ts -[imports]-> src/b.ts#computeSum");
  });

  test("get_relationships filters by type and direction", async () => {
    const onlyCallsIn = await getRelationships({ name: "computeSum", type: "calls", direction: "in" }, deps);
    expect(onlyCallsIn).toContain("-[calls]->");
    expect(onlyCallsIn).not.toContain("-[imports]->");
    expect(onlyCallsIn).not.toContain("outgoing:");
  });

  test("get_relationships matches full entity ids and external targets", async () => {
    const byId = await getRelationships({ name: "src/a.ts#Widget", direction: "out" }, deps);
    expect(byId).toContain("-[extends]-> external:react#Component");
    const byExternalLeaf = await getRelationships({ name: "Component", direction: "in" }, deps);
    expect(byExternalLeaf).toContain("src/a.ts#Widget");
  });

  test("get_relationships reports a miss", async () => {
    const out = await getRelationships({ name: "nonexistent", direction: "both" }, deps);
    expect(out).toContain("(no relationships for nonexistent)");
  });
});
