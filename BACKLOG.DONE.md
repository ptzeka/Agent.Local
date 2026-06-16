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

## M3 — Engine extraction (vectorizer / vectorstore / mcp / codemcp / memomcp)

Completed slices of the "split into 5 packages" grooming. All 6 packages shipped.

### External MCP per-session mounting — `~1d`
Enables the agent to connect to external stdio MCP servers (declared in `mcp.json`) at
runtime, with per-session isolation. Prerequisite for M3-18 (start-of-turn memory recall).

- [x] `runtime/middleware/external-mcp.ts`: `readMcpServerDefs` (reads `mcp.json` without
      throwing on missing file) + `mountExternalMcp` (spawns one stdio server, wraps as `Mcp`,
      self-disposes on `runtimeSignal`). `defaultCwd` resolves the package root from the
      script path so codemcp's index auto-discovery works without per-server `cwd` config.
- [x] `McpRegistryMiddleware` updated to `await mountServers`: synthetic servers matched by
      name; any unrecognized name looked up in `mcp.json` and spawned as stdio. Declared-but-
      unmounted semantics preserved for the executor.
- [x] memomcp wired as a **per-session** server: `memoryCollectionFor(session)` derives the
      collection id from the session; `memomcp` is appended with `--collection <id>` so each
      spawned instance reads/writes only that session's memories. Added to executor + orchestrator
      `mcp` lists in `models.json`.
- [x] `session.ts` gets `memoryCollectionFor` helper; tests in `tests/middleware/external-mcp.test.ts`.

**Done when:** the agent mounts external stdio servers from `mcp.json` at build time with no
registry-side teardown, memomcp runs per-session-scoped, and the declared-but-unmounted executor
semantics are unchanged. ✅ DONE
  _created 2026-06-15 · updated 2026-06-15 · by Periklis Tzeka_

### `src/codemcp` on the engine — `~1d` · P2
Part of the M3-7 "split into 5 packages" grooming (package 4 of 6). Migrates codemcp's
retrieval layer onto the shared `vectorstore` + `vectorizer` packages, adding the two-tier
locate→expand and related_code tools from M3-14/M3-15.

- [x] `codeRetrieval.ts` updated: `CodeRetrieval` wraps `IVectorStore`; `searchByEmbedding`,
      `findSymbol`, `getFileChunks` route through the generic store; code fields (area/kind/
      symbol/lines/imports) live in `metadata` via `toChunkRow`/`toFilter`. `IVectorService`
      (from `vectorizer`) drives query embedding.
- [x] Two-tier tools added: `locate_code`/`locate_symbol`/`locate_file` return `ChunkSummary`
      (content-free); `expand_chunk` fetches one body by citation. One-shot
      `search_code`/`find_symbol`/`get_file_context` unchanged.
- [x] `related_code` tool: `CodeRetrieval.relatedTo` → `IVectorStore.relatedTo`; citation
      parsed to chunk id; non-boundary citations refused with a corrective error.
- [x] `vectorstore` gains `searchSummaries`/`listSummaries`/`relatedTo` (M3-14/M3-15 store
      primitives) in the same commit; pg and file backends covered; 56 new tests.
- [x] Integration-tested end-to-end via `src/codemcp/integrationtests.sh`; `search_code`,
      `find_symbol`, `get_file_context`, `locate_*`, `expand_chunk`, `related_code` all
      validated against the live index.

**Done when:** codemcp reads through `IVectorStore` + `vectorizer`, one-shot tools produce
identical output, two-tier locate→expand and `related_code` are live, integration tests green.
✅ DONE
  _created 2026-06-15 · updated 2026-06-15 · by Periklis Tzeka_

---

### Prior engine packages (vectorizer / vectorstore / codeindex / mcp / memomcp)

Completed slices of the "split into 5 packages" grooming. All 6 packages done (codemcp above).

### M3-13 · Retrieval Phase 1 — embeddings write-only on reads — `~0.5d` · P2
Phase 1 of **M3-10**. No reader ever consumes `.embedding` off a result: codemcp
`toChunkRow` and memomcp `toRecalled` both drop it; `searchByEmbedding` uses it
*internally* for scoring only. So returning it is dead weight in 100% of call sites —
and it is the single biggest field (a per-row 1024-float vector). Low-risk, universal,
and a prerequisite for the phases below.

- [x] Make `embedding` an **input-only** field: present on the `upsert` record type,
      absent from `SearchHit.record` / `list()` results (`RetrievedRecord = Omit<VectorRecord,
      'embedding'>`). `get(namespace, id)` keeps the full record (re-embed / migrate /
      export — and Phase 3 more-like-this — are the callers that need the vector back).
- [x] pg: dropped `embedding::text` from the read `SELECT`s (it never leaves the DB); file:
      `toRetrieved` strips before return.
- [x] Added the optional defensive `limit?` to `list(namespace, filter?, limit?)` (ALL by
      default); wired into codemcp `find_symbol`/`get_file_context`.
- [x] Tests: read paths ship no `embedding`; `get` still returns it; `list` respects the cap.

**Done when:** `searchByEmbedding`/`list` never carry an embedding, `get` still returns it,
and `list` accepts an optional `limit` — a universal payload cut for codemcp + memomcp. ✅ DONE
(`RetrievedRecord` on `searchByEmbedding`/`list`; pg + file strip the vector; `get` keeps the
full `VectorRecord`; `list` gained `limit?`. vectorstore + codemcp + memomcp build green, tests pass.)
  _created 2026-06-15 · updated 2026-06-15 · by Periklis Tzeka_

### M3-14 · Retrieval Phase 2 — content-free summary tier (two-tier locate→expand) — `~1d` · P2
Phase 2 of **M3-10**; depends on M3-13. A distinct honest type, not a flag on the existing
methods: both consumers already hand-roll the narrowed shape (`RecalledMemory`,
`ChunkRow`-without-body), and a record with `content: ''` would make the type lie.

- [x] `interface VectorSummary { id; namespace; metadata }` (+ `score?` on a `SummaryHit`) and
      `searchSummaries(...)` / `listSummaries(...)` on `IVectorStore`; `get(namespace, id)` is
      the expand. pg selects only summary columns; file strips `content` too.
- [x] **codemcp two-tier tools.** `locate_code`/`locate_symbol`/`locate_file` return content-free
      summaries; `expand_chunk` pulls one body by citation. Additive — the one-shot full path
      (`search_code`/`find_symbol`/`get_file_context`) stays. Integration-tested end-to-end.
- [x] **memomcp recall two-tier.** `recall_locate` (core + top-k archival as content-free
      summaries) → `recall_expand` (full bodies by vectorId) — same `VectorSummary` primitive,
      not a second mechanism. The one-shot `recall` stays.
- [x] Tests: a summary search ships no `content` (pg never selects it / file drops it);
      expand-by-id returns the same body the one-shot path did. (codemcp + memomcp suites.)
- [ ] **Pairs with M3-8/M3-9 streaming** — deferred to those stories; the summary tier is the
      unit they will stream (not a blocker for this story).

**Done when:** codemcp and memomcp retrieve in two tiers — a content-free summary to locate,
then by-id drill-down to expand — via `VectorSummary` + `searchSummaries`/`listSummaries` as
generic primitives both consume, with no body shipped until expand. ✅ DONE (codemcp
`locate_*`/`expand_chunk` + memomcp `recall_locate`/`recall_expand`; both suites green; codemcp
flow validated by `src/codemcp/integrationtests.sh`).
  _created 2026-06-15 · updated 2026-06-15 · by Periklis Tzeka_

### M3-15 (part) · Retrieval Phase 3 — semantic more-like-this primitive — `~0.5d` · P2
First slice of Phase 3 of **M3-10**; depends on M3-13 (`get` keeps the embedding) and M3-14.
The store-level "show me what's related to THIS record" primitive. The remaining
consumer-side relatedness (structural / hybrid / MMR / symbol boost) is tracked open as
**M3-15b** in [BACKLOG.md](BACKLOG.md).

- [x] **Semantic neighbors (more-like-this).** `relatedTo(namespace, id, k, filter?)` on
      `IVectorStore`, excluding the anchor. pg keeps the seed vector server-side via a single
      `WITH seed AS (SELECT embedding …)` CTE (the vector never crosses the wire); file ranks by
      the seed's stored embedding. codemcp `CodeRetrieval.relatedTo` + the `related_code` tool
      expose it (takes a `path:start-end` citation, refuses non-boundary ranges).
- [x] Tests: `relatedTo` excludes the anchor; bad-citation refusal; integration-tested in
      `src/codemcp/integrationtests.sh` (seed excluded, neighbours returned).

**Done when:** a store-level `relatedTo` primitive ranks an anchor's semantic neighbours
(seed excluded, vector never leaving the DB on pg) and codemcp exposes it. ✅ DONE.
  _created 2026-06-15 · updated 2026-06-15 · by Periklis Tzeka_

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
