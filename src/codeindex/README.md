# codeindex

Repository vectorizer. Walks a working tree, chunks it semantically, embeds the
chunks (via `@agent-local/vectorizer`), and writes them to PostgreSQL/pgvector or
a local file directory (via `@agent-local/vectorstore`). The output is consumed by
[codemcp](../codemcp/), which serves it to coding assistants over MCP.

## Build

```bash
cd src/codeindex
npm install
npm run build      # → dist/cli.js
```

## Commands

Run from the repo root you want indexed (`--root <path>` to index elsewhere):

```bash
# show what would be indexed, no backend writes
node src/codeindex/dist/cli.js plan

# apply pending migrations (--status to inspect without applying)
node src/codeindex/dist/cli.js --backend pg   migrate
node src/codeindex/dist/cli.js --backend file migrate

# migrate + chunk + embed + write the current commit (idempotent per commit sha)
node src/codeindex/dist/cli.js --backend pg   publish
node src/codeindex/dist/cli.js --backend file publish
```

`pack-and-publish` is an alias for `publish`.

### Global flags

| Flag | Default | Notes |
|---|---|---|
| `-r, --root <path>` | `cwd` | Directory to walk. Config defaults to `<root>/codeindex.config.json`. |
| `-c, --config <path>` | `<root>/codeindex.config.json` | Optional; only `connectionString` + `excludeGlobs` live here. |
| `-b, --backend <pg\|file>` | `pg` | Storage backend. The `file` backend always writes `src/codeindex/data/` (cwd-independent, no flag). |
| `--branch <name>` | `main` | Branch recorded on the commit row. |
| `--repository <name>` | auto-detect | `owner/repo` from `origin`, else the resolved absolute root path. Scopes multi-repo backends with `branch`. |
| `--embed-provider <local\|voyage\|openai>` | `local` | `local` is an offline hashed bag-of-tokens (dev only); `voyage`/`openai` read `VOYAGE_API_KEY` / `OPENAI_API_KEY` from env. |
| `--embed-dim <n>` | `768` | Must match the `chunks.embedding` column for the pg backend. |

### File-backend handoff

```bash
node src/codeindex/dist/cli.js --backend file publish   # → src/codeindex/data/
cp -r src/codeindex/data src/codemcp/data               # codemcp reads src/codemcp/data/
```

## See also

- [ARCHITECTURE.md](../../ARCHITECTURE.md) — how codeindex fits the wider platform.
- [BACKLOG.md](../../BACKLOG.md) — open work on the indexer / shared vector engine (M3-6, M3-11, …).
- [codemcp](../codemcp/) — the MCP server that reads what codeindex writes.
- [migrations/001_init.sql](./migrations/001_init.sql) — schema (commits, chunks, HNSW index).
- [codeindex.config.example.json](./codeindex.config.example.json) — config-file template.
