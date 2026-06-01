# codemcp

Model Context Protocol server that exposes the [codeindex](../../tools/codeindex/) repository index to coding assistants (Claude Code, Cursor, any MCP-compatible client). Stdio transport. Backed by either PostgreSQL/pgvector or a local file directory — same interface, swap with one flag.

## Build

```bash
cd src/codemcp
npm install
npm run build
```

Produces `dist/server.js`.

## Invocation

```
node dist/server.js [global-options] <command>
```

`process.cwd()` is the working directory for resolving the config file and `--file-dir`. There is no environment-variable fallback — every value has exactly one source (CLI flag, config file, or built-in default).

### Global options

| Flag | Default | Source priority | Notes |
|---|---|---|---|
| `-c, --config <path>` | `./codemcp.config.json` | CLI | Path to the config file (relative to cwd). |
| `-b, --backend <pg\|file>` | `pg` | CLI | Storage backend. |
| `--branch <name>` | `main` | CLI | Default branch to query when a tool call omits `commit`. |
| `--embed-provider <local\|voyage\|openai>` | `local` | CLI | Must match the provider used at index time. |
| `--embed-dim <n>` | `768` | CLI | Must match the indexed commit's dimensionality. |
| `--pg-dsn <dsn>` | from config / built-in | CLI > config > default | Postgres connection string. Prefer the flag for secret injection. |
| `--expected-migration <name>` | `001_init.sql` | CLI | Refuse startup if the backend's latest applied migration is older. |
| `--repository <name>` or `<name:path>` | (none) | CLI | File backend: **`owner/name` only** → data under `tools/codemcp/data/{name}/` (relative to the codemcp package). **`owner/name:absPath`** → `{path}/.codemcp/data/{name}/`. Repeat the flag, **or** pass several entries in one value separated by **`;`**. **Omit entirely** to auto-register every distinct `repository` id found under the default file index (`tools/codeindex/data` when present, else `tools/codemcp/data`). First registration is the fallback default when git `origin` does not match any registered name. |

The file backend reads indexed JSON from disk: either **`tools/codemcp/data/{repository}/...`** when you pass **`--repository owner/name`** (name only), or **`{clone}/.codemcp/data/{repository}/...`** when you pass **`--repository owner/name:/absolute/clone`**. There is no `--file-dir` flag.

Only `connectionString` lives in the optional `codemcp.config.json` file:

```json
{
  "connectionString": "postgres://codeindex_user:CHANGE_ME@localhost:5432/codeindex"
}
```

## Commands

### `serve` (default)

Starts the stdio MCP server. This is what Claude Code launches.

```bash
# Postgres backend
node dist/server.js --backend pg --pg-dsn "postgres://user:pw@host/db"

# File backend — simplest: no --repository; discovers every repo id in tools/codeindex/data (after publish)
cd <repo-root>/tools/codemcp && node dist/server.js --backend file

# Or pin one or more names explicitly:
cd <repo-root>/tools/codemcp && node dist/server.js --backend file --repository Platform/Rxo.Platform.Web.Sandbox
# Populate tools/codemcp/data/Platform/Rxo.Platform.Web.Sandbox/ from codeindex output first (unless using shared codeindex/data).
```

The server reads JSON-RPC from stdin, writes responses to stdout, and prints status to stderr.

### `probe <tool> [argsJson]`

Invoke a single tool from the command line without an MCP client. **One-shot — not an interactive prompt.** The process starts, runs the tool, prints to stdout, and exits.

```
node dist/server.js --backend file --branch <branch> probe <tool> <json-args>
```

The JSON argument needs **shell-specific quoting**:

| Shell | Form |
|---|---|
| bash / zsh / git-bash | `'{"query":"X","k":5}'` (single quotes preserve inner `"`) |
| **PowerShell 5.1 (Windows default)** | `'{\"query\":\"X\",\"k\":5}'` (backslash-escape inner `"` inside single quotes) |
| cmd.exe | `"{\"query\":\"X\",\"k\":5}"` (double-quote outside, escape inside) |

Example (bash):

```bash
node dist/server.js --backend file --branch main \
  probe search_code '{"query":"connection factory","k":5}'
```

Example (PowerShell):

```powershell
node dist/server.js --backend file --branch main `
  probe search_code '{\"query\":\"connection factory\",\"k\":5}'
```

> Why: PowerShell 5.1 strips embedded `"` characters during the argv handoff to native executables. Backslash-escaping the inner quotes is the canonical workaround.

In the tool reference below, each "probe example" block shows both bash and PowerShell forms. Prepend `node dist/server.js --backend <pg|file> --branch <branch>` to get the full command.

### `tools`

Lists every registered MCP tool with its input schema.

```bash
node dist/server.js tools
```

## Tool reference

All tools return text in this format so the assistant can quote without hallucinating:

```
repository: <name>  branch: <branch>  commit: <sha7>
---
[<path>:<startLine>-<endLine>] (<language> <kind>) <symbol>  score=<cosine-distance>
commit: <sha>  area: <area>
governed by: <CLAUDE.md paths>
---
<chunk content>
```

The first line is a **resolution header** showing exactly which slice of the index was queried (repository / branch / commit). When `commit` is omitted, the server uses the only indexed snapshot for that repository **and** configured `--branch` when unambiguous; if more than one commit SHA exists for that pair, the tool refuses until you pass `commit` (see `list_commits`).

### Multi-repository support

A single backend can hold commits from multiple repositories. Every commit row carries a `repository` identifier (e.g. `owner/repo` from the indexer, or a path-based id), set at publish time.

**File backend — multiple `--repository name:path` flags (or one flag with `name:path` pairs separated by `;`), or auto-discovery:**

- With **explicit** registrations, each gets its own on-disk reader; **all are searchable** by passing the tool argument `repository` equal to that registration's **`name`** (the part before the first `:` in each pair).
- With **no** `--repository` flags and a migrated file index (`schema_versions.json` under the default data dir), the server **scans published commits** and registers every distinct `repository` field (same as listing each name with `--repository`). All share one physical tree when using sibling `tools/codeindex/data`.
- **`search_code`**, **`find_symbol`**, and **`get_file_context`** query **one** repo per call. If you omit `repository`, they use **git `origin`** when it matches a registered name, else the **first** registration (explicit order or sorted discovery order).
- **`list_commits`** with no `repository` filter **aggregates** every registered repo (sorted by `indexed_at`); pass `repository` to narrow to one name.

**Postgres backend:** one connection; multiple logical repos live in the same DB and are distinguished by the `repository` column. Pass `repository` on tool calls to target the right rows.

**When no `--repository` flags are passed (file backend):**

- If `schema_versions.json` exists under the default file index directory, **every distinct `repository` id** in published `commit.json` files is registered automatically (see above).
- Otherwise (legacy single-tree layout): the server **auto-detects** a default from `git config --get remote.origin.url` in `process.cwd()` when possible. If detection fails, tools that need a repo may refuse until you pass `repository` explicitly.

**Postgres / file with no migrated index:** same as before — git-origin default when possible.

---

### `search_code`

Semantic vector search. Best when you don't know the exact symbol name and want code by intent.

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `query` | string | yes | Natural-language or code-fragment query. |
| `k` | integer 1–50 | no (default 8) | Number of results. |
| `area` | enum | no | `api`, `backend`, `frontend`, `db`, `test`, `docs`, `tools`, `pipeline`, `minikube`, `root`. |
| `kind` | enum | no | `class`, `method`, `function`, `component`, `interface`, `record`, `section`, `statement`, `message`, `service`, `rpc`, `file`, `window`. |
| `language` | string | no | `csharp`, `typescript`, `tsx`, `javascript`, `jsx`, `markdown`, `sql`, `protobuf`, `json`. |
| `repository` | string | no | Repo id to query (must match a `--repository` **name** when several are registered). Defaults to the first registration or auto-detected repo. |
| `commit` | string | no | Full SHA. **Required** when more than one distinct SHA is indexed for the same `repository` + `--branch`; otherwise defaults to the sole snapshot. Use `list_commits` to list SHAs. |

**Probe example**

```bash
# bash / zsh / git-bash
probe search_code '{"query":"migration runner with checksum","k":3,"area":"tools"}'
```

```powershell
# PowerShell
probe search_code '{\"query\":\"migration runner with checksum\",\"k\":3,\"area\":\"tools\"}'
```

---

### `find_symbol`

Exact-match symbol lookup. Faster and more precise than `search_code` when you already know the name.

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Exact symbol (case-sensitive). |
| `repository` | string | no | Repo id; match a `--repository` **name** when several are registered. Defaults to first registration or auto-detected repo. |
| `commit` | string | no | Full SHA. **Required** when more than one distinct SHA is indexed for the same `repository` + `--branch`; otherwise defaults to the sole snapshot. Use `list_commits` to list SHAs. |

**Probe example**

```bash
# bash / zsh / git-bash
probe find_symbol '{"name":"PgConnectionFactory"}'
```

```powershell
# PowerShell
probe find_symbol '{\"name\":\"PgConnectionFactory\"}'
```

---

### `get_file_context`

Returns every chunk for a given file, plus the governing `CLAUDE.md` files. Use before editing a file the assistant hasn't seen.

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `path` | string | yes | Repository-relative path, forward slashes. |
| `repository` | string | no | Repo id; match a `--repository` **name** when several are registered. Defaults to first registration or auto-detected repo. |
| `commit` | string | no | Full SHA. **Required** when more than one distinct SHA is indexed for the same `repository` + `--branch`; otherwise defaults to the sole snapshot. Use `list_commits` to list SHAs. |

**Probe example**

```bash
# bash / zsh / git-bash
probe get_file_context '{"path":"src/codemcp/src/db/connectionFactory.ts"}'
```

```powershell
# PowerShell
probe get_file_context '{\"path\":\"src/codemcp/src/db/connectionFactory.ts\"}'
```

---

### `list_commits`

Enumerate indexed commit snapshots.

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `branch` | string | no | Restrict to a single branch. |
| `repository` | string | no | Restrict to a single repository. (Unlike the search tools, `list_commits` does NOT default to the current repo — it lists everything by default.) |
| `limit` | integer 1–100 | no (default 10) | Max rows. |

**Probe example**

```bash
# bash / zsh / git-bash
probe list_commits '{"branch":"main","limit":5}'
```

```powershell
# PowerShell
probe list_commits '{\"branch\":\"main\",\"limit\":5}'
```

## Wiring into Cursor (this repo)

Configure **`codemcp` in `~/.cursor/mcp.json`** (user MCP). Example:

- **`args`**: start with the **absolute** path to `tools/codemcp/dist/server.js` (Cursor sometimes runs MCP with `cwd` under your home directory, so a repo-relative path resolves to `/Users/you/tools/...` and fails).
- **`cwd`**: `.../tools/codemcp` so optional `codemcp.config.json` next to the package resolves predictably.

See [mcp.json.example](./mcp.json.example). Run `npm install && npm run build` under `tools/codemcp` after upgrades, ensure **`tools/codeindex/data/`** exists with migrations + commits (see below), then reload MCP.

### File data for name-only `--repository`

With **`--repository Platform/Rxo.Platform.Web.Sandbox`** (no `:path`), codemcp **prefers** the sibling indexer output **`tools/codeindex/data/`** when `schema_versions.json` exists there (normal layout after `npm run migrate:file` / `publish:file` in `tools/codeindex`). No copy into `tools/codemcp/data/...` is required in that setup.

If you keep index files only under `tools/codemcp/data/<owner>/<repo>/` instead, ensure that tree includes `schema_versions.json` (and `commits/<sha>/...`) — codemcp does **not** create that directory for you.

```bash
# Refresh the index (from tools/codeindex):
npm run migrate:file && npm run publish:file
```

## Wiring into Claude Code

Copy a block from [mcp.json.example](./mcp.json.example) into your `.claude/mcp.json` under `mcpServers`. Two ready-to-paste variants are included — one for the file backend (local debug), one for Postgres.

Once wired, Claude Code launches `codemcp` per session with the configured flags, and the four tools above become available for the model to call.

## Backend selection at a glance

| Backend | When to use | Storage location |
|---|---|---|
| `pg` (default) | Production / shared index | PostgreSQL with `pgvector`. Schema managed by `codeindex migrate`. |
| `file` | Local debug, no infra, grep-able artifacts | With **`--repository owner/name`**: `tools/codemcp/data/{name}/...`. With **`name:path`**: `{path}/.codemcp/data/{name}/...`. |

Both implement the same `PgReaderRepository` interface; you can switch on a single invocation without rebuilding.

## See also

- [tools/codeindex/](../../tools/codeindex/) — the indexer that produces the data this server reads.
- [Dockerfile](./Dockerfile) — minimal node:20-alpine image.



## COMMANDS 
node src/codemcp/dist/server.js --backend file --branch feature/add_solution probe find_symbol '{"name":"PgConnectionFactory"}'
node src/codemcp/dist/server.js --backend file --branch feature/add_solution probe get_file_context '{\"path\":\"src/codemcp/src/db/connectionFactory.ts\"}'
node src/codemcp/dist/server.js --backend file --branch feature/add_solution probe find_symbol '{\"name\":\"PgConnectionFactory\"}'

# Example do not delete:
node tools/codeindex/dist/cli.js --backend file --branch feature/add_solution publish && cp -R tools/codeindex/data/. tools/codemcp/data/ &&
node tools/codeindex/dist/cli.js --backend file --branch dev --repository /Applications/WWW/xpo-messaging-backend publish &&


.\scripts\publish-codeindex.ps1 -Repository C:\Users\periklis.tzeka\www\platform\Rxo.Platform.Web.Sandbox
.\scripts\publish-codeindex.ps1 -Repository C:\Users\periklis.tzeka\www\platform\xpo-messaging-backend
.\scripts\publish-codeindex.ps1 -Repository C:\Users\periklis.tzeka\www\Dev-Sandbox\poc-monorepo-ui
.\scripts\publish-codeindex.ps1 -Repository C:\Users\periklis.tzeka\www\central\rxo-design-system


.\scripts\publish-codeindex.ps1 -Branch main -Repository C:\Users\periklis.tzeka\www\DevOps\pipeline-variables
.\scripts\publish-codeindex.ps1 -Branch release/latest -Repository C:\Users\periklis.tzeka\www\DevOps\rxo.systems.azurepipelines

rm -R tools/codeindex/data
rm -R tools/codemcp/data
cp -R tools/codeindex/data/. tools/codemcp/data/
