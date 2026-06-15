# memomcp — integration test

Manual end-to-end check of `remember` → `recall` over the real wiring (vector store + embedder).
Run it after touching the repository, tools, or wiring, and before committing memomcp changes.

## How to run

Two equivalent paths — both hit the same `MemoryRepository`:

- **`probe` CLI** (no MCP registration needed; self-contained). Invokes one tool and prints its
  text result. Use this for the scripted check below.
- **MCP tools** (`remember` / `recall`) via a host that has memomcp registered. Same payloads,
  passed as tool arguments instead of JSON on argv.

Build first: `npm run -w @agent-local/memomcp build` (probe runs `dist/server.js`).

### Embed provider matters

- `--embed-provider local` — hashed bag-of-words, offline, deterministic. **Only token-overlap
  recall works**, not paraphrase. Fine for a smoke test that the wiring is sound.
- `--embed-provider voyage` — real semantic recall (needs `VOYAGE_API_KEY` in env). **Required to
  validate the actual acceptance criterion: paraphrase recall.** Default dim is 1024.

The payloads below are written so they pass under `local` (queries share tokens with the content)
*and* demonstrate paraphrase under `voyage` (see the paraphrase query at the end).

Use a throwaway collection (`itest`) so you never pollute `default`. Data lands in
`src/memomcp/data/memories/itest/` — delete it afterwards; never commit `data/`.

## 1. Save — full payloads

Each is a complete `remember` argument object. One `core` (always recalled) and several `archival`
(top-k by similarity), spanning two categories so the filter step has something to exclude.

```bash
B="--backend file --embed-provider local --collection itest"

node dist/server.js probe remember "$B" '{"content":"User is Periklis; prefers concise answers and dark-mode UIs.","kind":"core","category":"profile","tenant":"periklis","tags":["preference","identity"]}'

node dist/server.js probe remember "$B" '{"content":"The deploy pipeline runs nightly at 2am UTC and pushes to the staging cluster first.","kind":"archival","category":"ops","tenant":"periklis","tags":["deploy","schedule"]}'

node dist/server.js probe remember "$B" '{"content":"Postgres backups are stored in s3://acme-db-backups with 30-day retention.","kind":"archival","category":"ops","tenant":"periklis","tags":["backup","database"]}'

node dist/server.js probe remember "$B" '{"content":"Quarterly budget review meeting is held the first Monday of each quarter.","kind":"archival","category":"finance","tenant":"periklis","tags":["meeting","budget"]}'
```

Each call prints `remembered <kind> memory <id> in collection "itest"`. That `<id>` is the
**memory's own id** (`metadata.memoryId`), not the vector record id — keep one to drive the
overwrite step.

> Note `probe` flags must come before the JSON arg if you pass them per-call; or export `$B` as
> shown. The JSON is a single argv token — keep it quoted.

## 2. Retrieve — recall

### a) Similarity ranking

```bash
node dist/server.js probe recall "$B" '{"query":"when does the deploy pipeline run","k":2}'
```

Expect: the core profile memory under `# core` (always), and under `# archival` the deploy memory
ranked **above** the budget memory (lower `score` = closer cosine distance).

### b) Filter by category

```bash
node dist/server.js probe recall "$B" '{"query":"database backup retention","category":"ops","k":5}'
```

Expect: only the two `ops` archival memories. The `finance` budget memory **and** the `profile`
core memory are excluded — the filter applies to core as well as archival (`core: 0`).

### c) Overwrite-by-id (upsert)

Re-save with the `id` returned in step 1 for the deploy memory:

```bash
node dist/server.js probe remember "$B" '{"id":"<DEPLOY_MEMORY_ID>","content":"The deploy pipeline now runs hourly and deploys straight to production.","kind":"archival","category":"ops","tenant":"periklis","tags":["deploy","schedule"]}'

node dist/server.js probe recall "$B" '{"query":"how often does the deploy pipeline run","k":5}'
```

Expect: the deploy entry's content is replaced, the **id is unchanged**, and the archival count is
still **3, not 4** — proof it was an upsert, not an append-as-new. The vector record was re-embedded
but its identity (`vectorId`) stayed stable while the memory id held.

### d) Paraphrase recall (voyage only)

Re-seed with `--embed-provider voyage` (and `VOYAGE_API_KEY` set), then:

```bash
node dist/server.js probe recall "--backend file --embed-provider voyage --collection itest" '{"query":"what is our schedule for shipping releases","k":2}'
```

Expect the deploy memory to rank first **despite sharing almost no words** with the query — this is
the paraphrase capability `local` cannot demonstrate.

## 3. Cleanup

```bash
rm -rf src/memomcp/data/memories/itest
```

## Pass criteria

- [ ] All four saves return a memory id.
- [ ] (a) deploy memory ranks above budget for the deploy query.
- [ ] (b) category filter drops both the finance and the core memory.
- [ ] (c) overwrite keeps the id, replaces content, archival count stays 3.
- [ ] (d) under voyage, paraphrase query surfaces the deploy memory.
