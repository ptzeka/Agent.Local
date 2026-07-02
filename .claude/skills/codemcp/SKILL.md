---
name: codemcp
description: Operate codemcp end-to-end as an AI agent — (re)index a repository with codeindex, validate the codemcp MCP server is running and serving that index, and pick the right retrieval tool (locate vs expand tiers). Use when asked to index/reindex a repo, when codemcp tools are missing or return "(no indexed commits)" / "(no results)" unexpectedly, or before relying on the index after a large change.
---

# codemcp: index a repository & validate the server

Paths below (`REPO_ROOT`, `CODEINDEX_PATH`, `CODEMCP_PATH`, `INDEX_DATA`) come from
the repo-root `deps.md` (machine-local, gitignored) — read it first. If it is
missing, follow the template at the bottom of [INSTALL.md](../../../INSTALL.md).

## Index a repository

1. Ensure codeindex is built: `<CODEINDEX_PATH>/dist/cli.js` exists, else
   `npm run build --workspace=src/codeindex` from `REPO_ROOT`.
2. Publish a snapshot of the current commit:
   ```bash
   cd <CODEINDEX_PATH> && npm run publish:file
   ```
   For a repository other than this one, point the publisher at it explicitly:
   ```bash
   node dist/cli.js --backend file publish --root <other-repo-root> --repository <owner/name>
   ```
3. The publish output echoes `commitSha`, `fileCount`, `chunkCount`, `edgeCount` —
   treat a publish without that JSON as failed.
4. Reindexing after commits is the same command; the layout is repo-first, so each
   commit sha gets its own snapshot under `INDEX_DATA/<owner>/<repo>/commits/<sha>/`
   (`chunks.jsonl` + `commit.json` + `edges.jsonl`, journal at
   `INDEX_DATA/<owner>/<repo>/schema_versions.json`).

Notes:
- The index is per-commit: query results always carry the sha they came from. If
  `resolveCommit` complains about multiple snapshots, pass `commit` explicitly.
- `repository` ids are full ids (e.g. `owner/name`, or the registered
  multi-repo name) — never the bare repo folder name. When unsure, call
  `list_commits` first and copy the `repository=` value it prints.
- A checksum-mismatch error from the migration journal means the repo's
  `schema_versions.json` predates a changed migration; the store is disposable —
  delete that repo's subtree under `INDEX_DATA` and republish.

## Validate the MCP server is running

Work top-down; the first failing check names the fix.

1. **Registered?** the `codemcp` key exists in the global MCP config (see
   `CLAUDE_GLOBAL_MCP` in deps.md) and `args[0]` points at this checkout.
2. **Built?** `ls <CODEMCP_PATH>/dist/server.js` — missing means build codemcp.
3. **Indexed?** `ls <INDEX_DATA>/<owner>/<repo>/schema_versions.json
   <INDEX_DATA>/<owner>/<repo>/commits` — missing means run the indexing section above.
4. **Answers standalone?** (bypasses the host entirely)
   ```bash
   node <CODEMCP_PATH>/dist/server.js --backend file probe list_commits '{}'
   ```
   Non-zero exit or an error means the server itself is broken; `... server.js tools`
   lists valid tool names.
5. **Answers live?** call `mcp__codemcp__list_commits` in the session — it must show
   the snapshot you just published (matching sha). Tools absent → the host needs a
   restart or the registration is malformed.

## Choosing a retrieval tool

- Know the exact name → `get_symbol` (bodies) or `locate_symbol` (outline only).
- Who calls / imports / implements / extends X → `get_relationships` (edge graph;
  pass a symbol name, `path#Class.method` id, or file path; filter with
  `type`/`direction`). Vector tools cannot answer these questions.
- Searching by meaning → `locate_code` first (content-free summaries), then
  `expand_chunk` on the `[path:start-end]` citations worth reading; `search_code`
  when you want bodies in one call.
- Understanding a file → `locate_file` for its symbol outline, `get_file_context`
  for everything including governing CLAUDE.md files.
- "More like this chunk" → `related_code` with the seed's citation.
- Class methods are indexed as their own chunks (`kind=method`,
  `parentSymbol=<class>`), so prefer querying the method name over the class name.
