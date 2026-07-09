---
name: install-mcp-servers
description: Install the agent.tools MCP servers (codemcp + memomcp, the memo MCP) into the user's global Claude (~/.claude.json) and Cursor (~/.cursor/mcp.json) configs. Use when asked to install/register/update these MCP servers in Claude Code or Cursor, to point a global MCP config at the agent.tools checkout, or to debug why codemcp/memomcp tools are missing or not answering.
---

# Install MCP servers

The servers live in the standalone **agent.tools** monorepo (`TOOLS_ROOT`, this
machine: `c:\www\agent.tools`), not in this repo. Two stdio MCP servers, exposed
as globally-linked CLI commands:

- `codemcp` — code search over the codeindex store: `npx @peritze/codemcp --backend file`
- `memomcp` — agent memory (remember/recall): `npx @peritze/memomcp --backend file --embed-provider local`

`TOOLS_ROOT/mcpServers.json` is the **template** for the repo-scoped registration.
There is no installer script — register the servers by editing the global config
files directly (steps below), so unrelated entries are preserved.

Two invocation forms, chosen by working directory (npm ≥7 npx does NOT fall back to
globally-installed packages — it only resolves the local `node_modules`, then the registry):

- **cwd inside `TOOLS_ROOT`** → `npx @peritze/codemcp ...` (resolves the workspace).
  Always the scoped name, never bare `npx codemcp`: an unrelated `codemcp` package
  exists on the public registry, and the scope makes npx fail loudly instead of fetching it.
- **any other cwd** (including this repo) → the bare bin shims `codemcp` / `memomcp` /
  `codeindex`, which `npm run link:cli` (run in `TOOLS_ROOT`) places on the PATH
  (global npm prefix), pointing at that checkout.

## Targets

| Target | File | Where the entries go |
| --- | --- | --- |
| `claude` | `~/.claude.json` | top-level `mcpServers` |
| `cursor` | `~/.cursor/mcp.json` | top-level `mcpServers` |

## Install (ordered — run as the AI agent)

The data flow is **build → index → link → register → verify**. Do them in order; a
later step is meaningless if an earlier one was skipped.

1. **Build the workspaces.** `dist/server.js` must exist or the command can't launch.
   ```bash
   cd <TOOLS_ROOT> && npm install && npm run build
   ```

2. **Build the code index** (only codemcp needs this; memomcp has no index step).
   This chunks + embeds the target repo into the file-backend store that codemcp serves.
   ```bash
   cd <TOOLS_ROOT> && npx @peritze/codeindex publish --backend file --root <repo-to-index>
   ```
   codemcp auto-discovers this store at the sibling `codeindex/data/`
   (it looks for `schema_versions.json` there).

3. **Link the CLI commands globally** so the `codemcp`/`memomcp`/`codeindex` shims
   exist on the PATH from any directory. The link points at the agent.tools checkout,
   so a rebuild updates the commands in place.
   ```bash
   cd <TOOLS_ROOT> && npm run link:cli
   ```

4. **Register the servers** in each target config. Read the JSON, add/overwrite the
   `codemcp` and `memomcp` keys under `mcpServers`, keep every other key untouched,
   write it back. Global configs launch servers from whatever project is open, so
   they must use the linked shims — no absolute paths, no npx:
   ```json
   "codemcp": {
     "type": "stdio",
     "command": "codemcp",
     "args": ["--backend", "file"]
   },
   "memomcp": {
     "type": "stdio",
     "command": "memomcp",
     "args": ["--backend", "file", "--embed-provider", "local"]
   }
   ```
   (The `TOOLS_ROOT/mcpServers.json` template keeps the `npx @peritze/...` form instead —
   it always launches with cwd = that checkout. If a host can't spawn `.cmd` shims on
   Windows, fall back to `"command": "cmd", "args": ["/c", "codemcp", ...]`.)

5. **Restart** Claude Code / Cursor so the host respawns the MCP servers.

6. **Verify** (next section).

## Debug & verify (run as the AI agent)

Work top-down — registered → linked → answers standalone → answers in the live session.
Stop at the first failing check; it tells you which earlier step to redo.

1. **Registered?** Confirm both keys exist and use the shim form above:
   ```bash
   node -e "const c=require(require('os').homedir()+'/.claude.json'); console.log(JSON.stringify(c.mcpServers,null,2))"
   ```
   Missing key, a stale `node <path>/dist/server.js` entry, or an npx entry (fails
   outside this checkout) → redo step 4.

2. **Linked?** The global npm prefix must carry both packages:
   ```bash
   npm ls -g @peritze/codemcp @peritze/memomcp
   ```
   Missing → redo step 3 (and step 1 first if `dist/` is absent).

3. **Indexed?** codemcp needs a populated store:
   ```bash
   ls <TOOLS_ROOT>/codeindex/data/*/*/schema_versions.json
   ```
   Missing → redo step 2.

4. **Answers standalone?** Drive each server's `probe` subcommand — it runs one tool
   end-to-end against the file backend and prints the result. Non-zero exit or an
   error means the server is broken regardless of registration. Run from OUTSIDE the
   repo to prove the global shims resolve:
   ```bash
   codemcp --backend file probe list_commits '{}'
   memomcp --backend file --embed-provider local probe recall '{"query":"smoke test"}'
   ```
   List a server's tools with `codemcp tools` if a tool name is unknown.

5. **Answers in the live session?** After a restart, the host exposes the tools as
   `mcp__codemcp__*` and `mcp__memomcp__*`. If they don't appear, the entry is
   malformed or the host wasn't restarted — recheck steps 4–5 of Install.

## Notes

- To change what gets installed, edit `TOOLS_ROOT/mcpServers.json` (the template) and
  mirror the change into the registered configs.
- Secrets (e.g. a Postgres DSN for the `pg` backend) belong in the launching tool's
  args, never committed.
- `npm run unlink:cli` (in `TOOLS_ROOT`) removes the global links (e.g. before pointing
  them at a different checkout via that checkout's `link:cli`).
