# codeindex

Repository vectorizer. Walks a working tree, chunks it semantically, embeds the chunks, and publishes them to either PostgreSQL/pgvector or a local file directory. The output is consumed by [codemcp](../../src/codemcp/), which exposes it to coding assistants via the Model Context Protocol.

## Build

```bash
cd tools/codeindex
npm install
npm run build
```

Produces `dist/cli.js`.

## Invocation

```
node dist/cli.js [global-options] <command>
```

The **directory being indexed** defaults to `process.cwd()`. Pass **`--root <path>`** to index another folder (path is resolved relative to cwd when relative). There is no environment-variable fallback for the tree root; other settings are CLI flags or the optional config file.

### Global options

| Flag | Default | Source priority | Notes |
|---|---|---|---|
| `-r, --root <path>` | `cwd` | CLI | Directory to walk for indexing. Config file defaults to `<root>/codeindex.config.json` when `-c` is omitted. |
| `-c, --config <path>` | `<root>/codeindex.config.json` | CLI | Path to the config file (resolved relative to cwd). |
| `-b, --backend <pg\|file>` | `pg` | CLI | Storage backend. |
| `--branch <name>` | `main` | CLI | Branch name recorded on the commit row. |
| `--embed-provider <local\|voyage\|openai>` | `local` | CLI | Embedding model provider. |
| `--embed-dim <n>` | `768` | CLI | Embedding dimensionality (must match `chunks.embedding` for pg backend). |
| `--repository <name>` | (auto-detect) | CLI | Override for the repository id on the commit row. When omitted: `owner/repo` from `remote.origin.url` if available, otherwise the **resolved absolute path** of the index root (forward slashes). Multi-repo backends filter by this string plus `branch`. |

The file backend always reads/writes `tools/codeindex/data/` (next to the binary). There is no `--file-dir` flag — keep it simple, predictable, and cwd-independent.

Only `connectionString` and `excludeGlobs` live in the optional `codeindex.config.json`:

```json
{
  "connectionString": "postgres://codeindex_user:CHANGE_ME@localhost:5432/codeindex",
  "excludeGlobs": [
    "**/node_modules/**",
    "**/dist/**",
    "**/bin/**",
    "**/obj/**",
    "**/publish/**",
    "**/.git/**"
  ]
}
```

The config file is optional — built-in defaults cover both fields when it's absent.

## Commands

### `plan`

Walks the working tree and prints the file list without touching the backend. Use this to sanity-check what would be indexed before running `publish`.

```bash
cd <repo-root>
node tools/codeindex/dist/cli.js plan
```

Output begins with a context block (root dir, backend, branch, embed provider/dim) so you can see exactly what would happen.

### `migrate`

Applies pending SQL migrations from [migrations/](./migrations/) to the configured backend.

| Backend | Behavior |
|---|---|
| `pg` | Executes each `.sql` script in a transaction, then records it in `schema_versions`. Forward-only; checksums are verified against the journal on every run. Uses a Postgres advisory lock so concurrent runs serialize. |
| `file` | Skips SQL execution (file backend has no schema engine), records the same migration name + checksum in `<file-dir>/schema_versions.json`. Keeps the journal in lockstep with what Postgres would have. |

```bash
# apply
node tools/codeindex/dist/cli.js --backend pg migrate
node tools/codeindex/dist/cli.js --backend file migrate

# status (no changes)
node tools/codeindex/dist/cli.js --backend pg migrate --status
```

### `publish`

Runs migrations first, then walks → chunks → embeds → writes the current commit. Idempotent at the commit-SHA level.

```bash
# Postgres
cd <repo-root>
node tools/codeindex/dist/cli.js --backend pg publish

# File backend (writes tools/codeindex/data/ — next to the binary)
cd <repo-root>
node tools/codeindex/dist/cli.js --backend file publish
node dist/cli.js --backend file --root /Applications/WWW/rxoinc/platform/Rxo.Platform.Web.Sandbox --branch main publish

node dist/cli.js --backend file --root /Applications/WWW/rxoinc/platform/xpo-messaging-backend --branch main publish


```

Emits a JSON summary on success:

```json
{
  "commitSha": "7e4073a83bfc93f537dcb062a68658ecd2932d66",
  "branch": "main",
  "repository": "rxo/Rxo.Platform.Web.Sandbox",
  "fileCount": 216,
  "chunkCount": 650,
  "modelId": "local:hashed-bag-768"
}
```

### Multi-repository indexes

Every commit is tagged with a `repository` identifier (`owner/repo` from `origin` when present, otherwise the resolved absolute path of the index root, or an explicit `--repository` override). A single backend can therefore hold commits from many repos; the [codemcp](../../tools/codemcp/) reader scopes its `latest commit for branch` lookup to `(repository, branch)` so two clones with overlapping branch names (e.g. both have a `main`) don't collide when they use distinct repository ids.

The Postgres `repository` column is **NOT NULL** with no default — every publish must produce one. The supporting migration is [migrations/002_add_repository.sql](./migrations/002_add_repository.sql). Existing pre-002 commits must be re-published (the migration sets them to an empty string, which the reader treats as "no repository" and excludes from repo-filtered queries).

### `pack-and-publish`

Alias for `publish`. Migrations and publishing are bundled in `publish` by default; this exists for the CI mental model where "pack" and "publish" feel like distinct steps.

## What gets indexed

The walker honors `.gitignore` at the cwd plus the `excludeGlobs` from the config (or the defaults: `node_modules`, `dist`, `bin`, `obj`, `publish`, `.git`). Indexable extensions: `.cs`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.md`, `.sql`, `.proto`, `.json`, `.yml`, `.yaml`. Files over 512 KB are skipped.

### Chunking

| File type | Chunker | Unit |
|---|---|---|
| `.cs` | brace-depth + regex header detection | class, record, interface, method |
| `.ts` / `.tsx` / `.js` / `.jsx` | brace-depth + regex header detection | function, class, interface, React component |
| `.md` | header-level walk | sections (preserves nesting) |
| `.sql` | statement splitter (string/dollar-quote aware) | individual statements with object names |
| `.proto` | brace-depth + regex header detection | message, service, rpc, enum |
| Everything else | 60-line sliding window, 10-line overlap | windowed chunks |

Each chunk carries: path, area, language, kind, symbol, parent symbol, line range, content hash, imports, and the lineage of `CLAUDE.md` files that govern it (walked upward from the file to the repo root).

### Embedding adapters

| Provider | Dependency | Output dim | Notes |
|---|---|---|---|
| `local` (default) | none | 768 | Deterministic hashed bag-of-tokens. Fully offline, zero setup. Quality is much weaker than a real model — use only for development. |
| `voyage` | `VOYAGE_API_KEY` env | configurable via `--embed-dim` | `voyage-code-3` by default (set `VOYAGE_MODEL` to override). Code-specialized; best retrieval quality. |
| `openai` | `OPENAI_API_KEY` env | configurable via `--embed-dim` | `text-embedding-3-small` by default (set `OPENAI_EMBED_MODEL` to override). |

> Note: API keys are read from environment by convention for the third-party providers (those packages expect that). Everything else is CLI-only.

## File backend layout

When `--backend file` is used, the index is always written to `tools/codeindex/data/` (next to the binary, cwd-independent):

```
tools/codeindex/data/
  schema_versions.json     # [{ scriptName, appliedAt, checksum }]
  commits/
    <commitSha>/
      commit.json          # CommitRow as JSON
      chunks.jsonl         # one ChunkRow per line (grep / jq friendly)
```

Everything is human-readable. The intended workflow is `cp -r tools/codeindex/data src/codemcp/data` — codemcp's file backend reads `src/codemcp/data/` with no flag.

## Postgres backend

The `pg` backend writes to a schema with two tables (`commits`, `chunks`) plus the `schema_versions` journal. See [migrations/001_init.sql](./migrations/001_init.sql) for the exact DDL, including the HNSW index on `chunks.embedding`.

Apply via:

```bash
cd <repo-root>
node tools/codeindex/dist/cli.js --backend pg migrate
node tools/codeindex/dist/cli.js --backend pg publish
```

Connection string is read from `codeindex.config.json` (`connectionString` field). No env-var fallback — keep secrets in the config file (which is gitignored) or pipe the file through a secrets manager.

## Typical workflows

### Local debug (no Postgres)

```bash
cd <repo-root>
node tools/codeindex/dist/cli.js --backend file --branch main publish
# → tools/codeindex/data/ now contains schema_versions.json + commits/<sha>/{commit.json,chunks.jsonl}

cp -r tools/codeindex/data src/codemcp/data
# codemcp's file backend always reads src/codemcp/data/, so no flag is needed:
node src/codemcp/dist/server.js --backend file --branch main probe list_commits
```

### Scope to a subdirectory

The index root controls *what gets indexed*, not where the output lands. Output always goes to `tools/codeindex/data/`. Either `cd` into the subtree or pass `--root`:

```bash
cd src/frontend
node ../../tools/codeindex/dist/cli.js --backend file --branch main publish
# → tools/codeindex/data/ contains only frontend chunks (cwd-scoped index)

# equivalent from repo root
node tools/codeindex/dist/cli.js --root src/frontend --backend file --branch main publish
```

### Production (Postgres on shared infra)

```bash
# one-time
cd <repo-root>
echo '{ "connectionString": "postgres://..." }' > codeindex.config.json   # add to .gitignore
node tools/codeindex/dist/cli.js --backend pg migrate

# on every push to main (CI)
node tools/codeindex/dist/cli.js --backend pg --branch main publish
```

### Switching embedding provider

Each provider produces a different `modelId` on the commit row. codemcp refuses to mix providers within a query, so re-publish whenever you switch:

```bash
VOYAGE_API_KEY=... node tools/codeindex/dist/cli.js \
  --backend pg --branch main --embed-provider voyage --embed-dim 1024 publish
```

## See also

- [src/codemcp/](../../src/codemcp/) — the MCP server that reads what codeindex writes.
- [migrations/001_init.sql](./migrations/001_init.sql) — schema.
- [codeindex.config.example.json](./codeindex.config.example.json) — config-file template.
