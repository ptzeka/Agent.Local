---
name: install-mcp-servers
description: Install this repo's MCP servers (codemcp + memomcp, the memo MCP) into the user's global Claude (~/.claude.json) and Cursor (~/.cursor/mcp.json) configs. Use when asked to install/register/update the repo's MCP servers in Claude Code or Cursor, to point a global MCP config at this checkout, or to debug why codemcp/memomcp tools are missing or not answering.
---

# Install MCP servers

This repo ships two stdio MCP servers:

- `codemcp` — code search over the codeindex store: `src/codemcp/dist/server.js --backend file`
- `memomcp` — agent memory (remember/recall): `src/memomcp/dist/server.js --backend file --embed-provider local`

The repo-root [_mcp.json](../../../_mcp.json) is the **template** showing the exact
entries. There is no installer script — register the servers by editing the global
config files directly (steps below), so unrelated entries are preserved.

## Targets

| Target | File | Where the entries go |
| --- | --- | --- |
| `claude` | `~/.claude.json` | top-level `mcpServers` |
| `cursor` | `~/.cursor/mcp.json` | top-level `mcpServers` |

## Install (ordered — run as the AI agent)

The data flow is **build → index → register → verify**. Do them in order; a later
step is meaningless if an earlier one was skipped.

1. **Build all three packages.** `dist/server.js` must exist or the server can't launch.
   ```bash
   cd src/codemcp   && npm install && npm run build
   cd src/memomcp   && npm install && npm run build
   cd src/codeindex && npm install && npm run build
   ```

2. **Build the code index** (only codemcp needs this; memomcp has no index step).
   This chunks + embeds the repo into the file-backend store that codemcp serves.
   ```bash
   cd src/codeindex && node dist/cli.js publish --backend file --root <repo-root>
   ```
   codemcp auto-discovers this store at the sibling `src/codeindex/data/`
   (it looks for `schema_versions.json` there).

3. **Register the servers** in each target config. Read the JSON, add/overwrite the
   `codemcp` and `memomcp` keys under `mcpServers`, keep every other key untouched,
   write it back. **Rebase the absolute path** in `args[0]` onto THIS checkout —
   replace the leading `<repo-root>` with the real absolute path of the current clone
   (e.g. `C:/www/Agent.Local`). Use forward slashes even on Windows.
   ```json
   "codemcp": {
     "type": "stdio",
     "command": "node",
     "args": ["<repo-root>/src/codemcp/dist/server.js", "--backend", "file"]
   },
   "memomcp": {
     "type": "stdio",
     "command": "node",
     "args": ["<repo-root>/src/memomcp/dist/server.js", "--backend", "file", "--embed-provider", "local"]
   }
   ```

4. **Restart** Claude Code / Cursor so the host respawns the MCP servers.

5. **Verify** (next section).

## Debug & verify (run as the AI agent)

Work top-down — registered → built → answers standalone → answers in the live session.
Stop at the first failing check; it tells you which earlier step to redo.

1. **Registered?** Confirm both keys exist and their paths point at THIS checkout:
   ```bash
   node -e "const c=require(require('os').homedir()+'/.claude.json'); console.log(JSON.stringify(c.mcpServers,null,2))"
   ```
   Missing key → redo step 3. Wrong/old path → rebase it (step 3).

2. **Built?** The `args[0]` path must exist:
   ```bash
   ls src/codemcp/dist/server.js src/memomcp/dist/server.js
   ```
   Missing → redo step 1.

3. **Indexed?** codemcp needs a populated store:
   ```bash
   ls src/codeindex/data/schema_versions.json src/codeindex/data/commits
   ```
   Missing → redo step 2.

4. **Answers standalone?** Drive each server's `probe` subcommand — it runs one tool
   end-to-end against the file backend and prints the result. Non-zero exit or an
   error means the server is broken regardless of registration:
   ```bash
   node src/codemcp/dist/server.js --backend file probe list_commits '{}'
   node src/memomcp/dist/server.js --backend file --embed-provider local probe recall '{"query":"smoke test"}'
   ```
   List a server's tools with `... <server.js> tools` if a tool name is unknown.

5. **Answers in the live session?** After a restart, the host exposes the tools as
   `mcp__codemcp__*` and `mcp__memomcp__*`. If they don't appear, the entry is
   malformed or the host wasn't restarted — recheck steps 3–4 of Install.

## Notes

- To change what gets installed, edit `_mcp.json` (the template) and mirror the change
  into the registered configs.
- Secrets (e.g. a Postgres DSN for the `pg` backend) belong in the launching tool's
  args, never committed.
