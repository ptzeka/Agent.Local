# INSTALL — codeindex + codemcp

Everything required for code search over this repo to work in Claude Code / Cursor:
both packages built, the repo indexed, the MCP server registered globally, and the
`codemcp` skill installed so an AI agent knows how to index and validate on its own.

This doc covers **code search only**. For `memomcp` (agent memory: remember/recall)
— build, global registration, and validation — see the
[`install-mcp-servers`](.claude/skills/install-mcp-servers/SKILL.md) skill, which
covers both MCP servers end-to-end.

**Read [deps.md](deps.md) first.** It is an uncommitted, machine-local cache of the
paths and variables the steps below reference (`REPO_ROOT`, `CODEINDEX_PATH`,
`CODEMCP_PATH`, global config paths, …). If it is missing, create it from the
template at the bottom of this file before doing anything else.

The order matters: **build → index → register → skills → verify**.

## 1. codeindex built and working

codeindex is the indexer/publisher: it chunks the repo (tree-sitter AST parser for
TS/JS, regex fallback), embeds the chunks, and publishes a per-commit snapshot into
`INDEX_DATA`.

```bash
cd <REPO_ROOT>
npm install --workspace=src/codeindex     # workspace install keeps the shared lockfile consistent
npm run build --workspace=src/codeindex
npm test  --workspace=src/codeindex       # parser suites must pass
```

Working means: `CODEINDEX_PATH/dist/cli.js` exists, tests pass, and the tree-sitter
prebuilds installed **without compiling** (no Python/C++ toolchain — `tree-sitter`
is pinned to a version that ships `prebuilds/` for darwin/linux/win32).

## 2. codemcp built and working

codemcp is the stdio MCP server that serves the published index to coding assistants.

```bash
cd <REPO_ROOT>
npm install --workspace=src/codemcp
npm run build --workspace=src/codemcp
npm test  --workspace=src/codemcp
```

Working means `CODEMCP_PATH/dist/server.js` exists and answers standalone:

```bash
node <CODEMCP_PATH>/dist/server.js --backend file probe list_commits '{}'
```

## 3. Index this repository

codemcp has nothing to serve until codeindex publishes at least one snapshot:

```bash
cd <CODEINDEX_PATH> && npm run publish:file
```

The layout is repo-first: confirm `INDEX_DATA/<owner>/<repo>/schema_versions.json`
and `INDEX_DATA/<owner>/<repo>/commits/<sha>/` exist, the latter holding
`chunks.jsonl` + `commit.json` + `edges.jsonl` (the relationship graph). codemcp
auto-discovers every `<owner>/<repo>/` subtree at the sibling `src/codeindex/data/`.

## 4. Register the MCP server in the global configs

Add a `codemcp` entry under `mcpServers` in each target, **preserving every other
key** (fsmcp/memomcp/etc. may already be registered). Use the absolute paths from
deps.md — forward slashes even on Windows. [_mcp.json](_mcp.json) is the template.

| Target | File (from deps.md) |
| --- | --- |
| Claude Code | `CLAUDE_GLOBAL_MCP` — `~/.claude/mcp.json` if present, else top-level `mcpServers` in `~/.claude.json` |
| Cursor | `CURSOR_GLOBAL_MCP` — `~/.cursor/mcp.json` |

```json
"codemcp": {
  "type": "stdio",
  "command": "node",
  "args": ["<REPO_ROOT>/src/codemcp/dist/server.js", "--backend", "file"]
}
```

Restart Claude Code / Cursor afterwards so the host respawns the server; the tools
then appear as `mcp__codemcp__*`.

## 5. Install the codemcp skill

[.claude/skills/codemcp/SKILL.md](.claude/skills/codemcp/SKILL.md) gives an AI agent
the instructions to (re)index a repository and to validate that the MCP server is
running. Inside this repo it is picked up automatically from `REPO_SKILLS`.

### Making any skill defined here global

Skills in `REPO_SKILLS` only apply inside this checkout. To make one available in
**every** project, copy its folder into the global skills directory
(`CLAUDE_GLOBAL_SKILLS`, i.e. `~/.claude/skills` — create it if missing):

```bash
mkdir -p <CLAUDE_GLOBAL_SKILLS>
cp -R <REPO_SKILLS>/codemcp <CLAUDE_GLOBAL_SKILLS>/codemcp
```

Same pattern for any other skill here (`install-mcp-servers`, `solid`,
`readability`, `debug-work`). Two caveats:

- A skill that references repo-relative paths (as `codemcp` and
  `install-mcp-servers` do) must state its absolute repo root when copied globally —
  the copies read `REPO_ROOT` from this repo's `deps.md`.
- The copy is a snapshot: after editing the repo skill, re-copy it.

## 6. Verify end-to-end

Work top-down; stop at the first failure — it names the step to redo.

1. **Registered?** the `codemcp` key exists in the target config and its `args[0]`
   points at THIS checkout.
2. **Built?** `ls <CODEMCP_PATH>/dist/server.js <CODEINDEX_PATH>/dist/cli.js`
3. **Indexed?** `ls <INDEX_DATA>/<owner>/<repo>/schema_versions.json <INDEX_DATA>/<owner>/<repo>/commits`
4. **Answers standalone?**
   `node <CODEMCP_PATH>/dist/server.js --backend file probe list_commits '{}'`
5. **Answers live?** after a host restart, call `mcp__codemcp__list_commits` — it
   must list the snapshot published in step 3; then
   `mcp__codemcp__get_symbol {"name":"wireParser"}` must return that function's
   line-precise chunk from src/wiring.ts, and
   `mcp__codemcp__get_relationships {"name":"IParser","direction":"in"}` must list
   its implementers and importers from the edge graph.

## deps.md template

`deps.md` is gitignored (machine-local). On a new machine create it at the repo root:

```markdown
# deps.md — local machine variables (uncommitted cache)

| Variable | Value |
| --- | --- |
| `REPO_ROOT` | <absolute path of this checkout> |
| `CODEINDEX_PATH` | <REPO_ROOT>/src/codeindex |
| `CODEMCP_PATH` | <REPO_ROOT>/src/codemcp |
| `NODE_BIN` | <output of `which node`> |
| `CLAUDE_GLOBAL_MCP` | ~/.claude/mcp.json (or ~/.claude.json `mcpServers`) |
| `CURSOR_GLOBAL_MCP` | ~/.cursor/mcp.json |
| `CLAUDE_GLOBAL_SKILLS` | ~/.claude/skills |
| `REPO_SKILLS` | <REPO_ROOT>/.claude/skills |
| `INDEX_DATA` | <REPO_ROOT>/src/codeindex/data |
| `DEFAULT_REPOSITORY_ID` | <git origin owner/repo> |
```
