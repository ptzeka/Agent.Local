# BACKLOG — Done

Archive of completed backlog items moved out of [BACKLOG.md](BACKLOG.md). Each
entry keeps its original text and carries a provenance line:

> `_created <date> · updated <date> · by <git user>_`

- **created** — when the item first entered the backlog (git pickaxe: the commit
  that added it).
- **updated** — last meaningful change (here: when it was marked done).
- **by** — the git author of record.

Newest milestones first.

---

## M3 — Engine extraction (vectorizer / vectorstore / mcp)

Completed slices of the "split into 5 packages" grooming. The shared
package-dependency diagram and the remaining consumers (`codemcp`, `memomcp`)
stay in [BACKLOG.md](BACKLOG.md).

- [x] **`src/vectorizer`** (leaf, `~1d`) — `EmbedAdapter { modelId, dim,
      embedBatch, embedQuery }` + `createEmbedAdapter(provider, dim)` over
      local/voyage/openai. Deletes the hand-mirrored `LocalQueryEmbedAdapter`
      in `codemcp/src/embed.ts` — one impl, no more "change one, change the
      other." Pure compute, no DB. — done 2026-06-14 (`@agent-local/vectorizer`:
      merged write-side `embedBatch` + read-side `embedQuery` into one adapter
      set; Voyage keeps document/query `input_type`; the duplicate `codemcp/embed.ts`
      is gone. Added the service tier `IVectorService` / `VectorServiceBase` /
      `VectorService.fromProvider` so versions (cached/remote) can swap; codeindex
      and codemcp now depend on `IVectorService`, not the raw adapter. `EmbedProvider`
      union lifted here, no longer duplicated in either config. 7 tests; both
      consumers build green.)
  _created 2026-06-14 · updated 2026-06-14 · by Periklis Tzeka_
- [x] **`src/vectorstore`** (leaf, `~1.5d`) — one copy of
      `DbConnection`/`DbConnectionFactory` (kills the byte-identical dupe across
      `codeindex/db/types.ts` and `codemcp/db/types.ts`), pg + file backends,
      generic `VectorRecord { id, namespace, content, embedding, metadata }` and
      `VectorStore { upsert, searchByEmbedding(ns, emb, k, filter), delete }`.
      `namespace` is opaque; filter is generic equality over `metadata`. — done
      2026-06-14 (`@agent-local/vectorstore`: `IVectorStore` with
      `upsert`/`get`/`searchByEmbedding`/`delete`/`deleteNamespace`/`listNamespaces`/`close`;
      `SearchHit { record, score }` where score is cosine distance. `PgVectorStore`
      (pgvector `<=>` rank + jsonb `@>` equality filter, `ensureSchema`, vector dim
      left UNPINNED per the sharp edge — consumer guards it). `FileVectorStore`
      log-structured: append on upsert, fold-by-id-last-wins on read, rewrite-compact
      on delete; rooted at `data/`, parameterizable `{ baseDir, partitionDir,
      recordsFile }` so `commits/<sha>/chunks.jsonl` and `memories/<ns>/records.jsonl`
      both fit. `DbConnection`/`DbConnectionFactory` + `PgConnectionFactory` now live
      here as the single home — codeindex/codemcp dedupe onto it when they migrate
      (tasks below, still open). The store never learns commit/snapshot. `PgVectorStore`
      takes a connection string OR a ready `DbConnectionFactory` so a pool can be shared
      (also makes SQL marshalling testable). 16 tests: 11 file-backend + 5 pg marshalling
      via a fake connection; leaf builds green, no consumers migrated yet.)
  _created 2026-06-14 · updated 2026-06-14 · by Periklis Tzeka_
- [x] **`src/codeindex` on the engine** (`~1d`) — walker/chunkers/commit
      unchanged; `publish.ts` writes through `vectorstore`, code fields into
      `metadata`. Output stays byte-compatible (`data/commits/<sha>/…`);
      golden-file test guards it. — done 2026-06-14 (depends on
      `@agent-local/vectorstore`: chunks now write through `IVectorStore` with
      `namespace = commitSha`; `FileVectorStore { partitionDir: 'commits',
      recordsFile: 'chunks.jsonl' }` keeps the `data/commits/<sha>/` layout, `pg`
      uses `PgVectorStore` sharing one pool with the commit factory. The duped
      `db/types.ts` + `PgConnectionFactory` now re-export from `vectorstore`; the
      repository collapsed to a commit-metadata + migration journal
      (`CommitRepository`, chunk methods gone), `commit.json` stays a
      codeindex-only sidecar. **Line shape changed** (flat `ChunkRow` → generic
      `VectorRecord`: code fields under `metadata`, new `id`/`namespace`), so
      `codemcp`'s reader must migrate before it can read this index again — see
      "`src/codemcp` on the engine" in BACKLOG.md. Migration 001 dropped its
      `chunks` table (the store owns `vector_records` via `ensureSchema`); the
      per-vector dim guard replaces the old `getEmbeddingDimension` column check.)
  _created 2026-06-14 · updated 2026-06-14 · by Periklis Tzeka_
- [x] **`src/mcp`** (new base/reference, `~1d`) — extract the MCP scaffolding
      that every server re-implements into one shared package so `codemcp` /
      `memomcp` (and future servers) derive from it instead of drifting. Move
      the trio out of `src/agent/src/agent/mcp/`: the **base contract**
      (`mcp.ts` — `Mcp` / `ToolInvoker` / `ToolExecutionResult`), the **actual**
      server (`mcp-client.ts` — `McpClient`, spawned stdio JSON-RPC), and the
      **virtual** server (`local-mcp.ts` — `LocalMcp`, in-process handlers).
      Ships a minimal reference server as the copy-from example; the agent
      imports the contract from here rather than owning it. — done 2026-06-14
      (`@agent-local/mcp`: trio + `ToolDescriptor` split into `tooldescriptor.ts`;
      `TokenUsage` lifted to `@agent-local/common`; every consumer repointed
      directly — no re-export shims; package owns its `src/tests` suite. No
      reference server shipped — deferred to memomcp.)
  _created 2026-06-14 · updated 2026-06-14 · by Periklis Tzeka_
- [x] **`src/memomcp`** (new, `~1.5d`) — standalone `remember`/`recall` server
      over `vectorstore` + `vectorizer`, partitioned by collection; the groom
      reframed M3-7 from "codemcp serves both" to a SEPARATE package (codemcp
      does NOT serve memory). — done 2026-06-15 (`@agent-local/memomcp`: wires
      `FileVectorStore { partitionDir: 'memories', recordsFile: 'records.jsonl' }`
      + `vectorizer`; `MemoryRepository.remember` embeds via `embedBatch`
      (voyage `input_type=document`) and upserts, `recall` loads all `core` by
      exact `list()` + top-k `archival` by `searchByEmbedding` (`embedQuery` →
      `input_type=query`). Flat records, tenant/category in `metadata` as recall
      filters, associations sidecar deferred. **Memory id vs vectorId settled
      2026-06-15**: two entities, `metadata.memoryId` is the memory's own id and
      `vectorId` (= `VectorRecord.id`) is an explicit reference, stable across
      re-embed on overwrite. Per-consumer `assertDim` guard. Tools `remember`/`recall`
      + `probe`/`tools` CLI; registered in `.mcp.json` + workspace; tsc clean,
      7/7 jest green. Manual end-to-end recipe in `src/memomcp/integrationtest.md`
      (ranking, category filter incl. core, overwrite-upsert, voyage paraphrase).
      Follow-ups still open in BACKLOG.md: M3-9 streaming, M3-10 two-tier recall,
      M3-12 persistent/Voyage store. **Not yet committed** — `src/memomcp/` still
      untracked.)
  _created 2026-06-15 · updated 2026-06-15 · by Periklis Tzeka_

---

## M1-4 — Prompt-cache strategy

Completed slices of the prompt-cache milestone; remaining bullets (determinism,
tripwire) stay under M1-4 in [BACKLOG.md](BACKLOG.md).

- [x] Anthropic (`providers/anthropic-provider.ts`): moving breakpoint on the
      LAST content block of the messages array each call — done 2026-06-10
      (`applyMessageBreakpoints`, tests in `tests/anthropic-cache.test.ts`).
  _created 2026-06-10 · updated 2026-06-10 · by Periklis Tzeka_
- [x] Third breakpoint ~15 blocks before the last for the 20-block lookback —
      done 2026-06-10, same change (budget: system 1 + messages 2 = 3 of 4).
  _created 2026-06-10 · updated 2026-06-10 · by Periklis Tzeka_
- [x] Gemini (`providers/gemini-provider.ts`): track `expireTime` from
      `caches.create` and recreate when near expiry — done 2026-06-10
      (`cacheExpiryMs` helper + 30s margin + tests in
      `tests/gemini-cache.test.ts`). Still open: verify the explicit cache
      isn't below flash-lite's minimum-token threshold in practice (if so,
      rely on Gemini 2.5 implicit prefix caching and delete the explicit path).
  _created 2026-06-10 · updated 2026-06-10 · by Periklis Tzeka_
