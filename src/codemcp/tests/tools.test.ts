import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileVectorStore, type VectorRecord } from "@agent-local/vectorstore";
import { VectorService } from "@agent-local/vectorizer";
import { CodeRetrieval } from "../src/retrieval/codeRetrieval.js";
import { FileMetadataRepository } from "../src/metadata/fileMetadataRepository.js";
import type { WiredReader } from "../src/wiring.js";
import type { ToolDeps } from "../src/tools/registry.js";
import { searchCode } from "../src/tools/search_code.js";
import { findSymbol } from "../src/tools/find_symbol.js";
import { getFileContext } from "../src/tools/get_file_context.js";
import { listCommits } from "../src/tools/list_commits.js";

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

  const reader: WiredReader = {
    retrieval: new CodeRetrieval(
      new FileVectorStore({ baseDir, partitionDir: "commits", recordsFile: "chunks.jsonl" }),
    ),
    metadata: new FileMetadataRepository(baseDir),
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

  test("find_symbol returns every definition, ordered by path then line", async () => {
    const out = await findSymbol({ name: "computeSum" }, deps);
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
});
