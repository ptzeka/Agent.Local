---
name: install-mcp-servers
description: Install this repo's MCP servers (codemcp + memomcp, the memo MCP) into the user's global Claude (~/.claude.json) and Cursor (~/.cursor/mcp.json) configs. Use when asked to install/register/update the repo's MCP servers in Claude Code or Cursor, or to point a global MCP config at this checkout.
---

# Install MCP servers

The repo root [mcp.json](../../../mcp.json) is the **source of truth**. It defines
the servers this repo ships:

- `codemcp` — `src/codemcp/dist/server.js --backend file`
- `memomcp` — the memo MCP, `src/memomcp/dist/server.js --backend file --embed-provider local`

[install.mjs](install.mjs) reads `mcp.json`, rebases the absolute
`dist/server.js` paths onto the current checkout (so it works on any clone), and
upserts each server into the global configs. Unrelated entries are preserved;
matching server names are overwritten.

## Targets

| Target | File |
| --- | --- |
| `claude` | `~/.claude.json` (top-level `mcpServers`) |
| `cursor` | `~/.cursor/mcp.json` |

## Run

```bash
# Preview without writing
node .claude/skills/install-mcp-servers/install.mjs --dry-run

# Install into both Claude and Cursor (default)
node .claude/skills/install-mcp-servers/install.mjs

# Install into one target only
node .claude/skills/install-mcp-servers/install.mjs --target cursor
```

## Notes

- The servers must be built (`dist/server.js`) to actually run. The installer
  warns if a server is unbuilt but still writes the entry. Build with:
  `cd src/codemcp && npm install && npm run build` (same for `src/memomcp`).
- Restart Claude Code / Cursor after installing to pick up the new servers.
- To add or change a server, edit `mcp.json` and re-run — it is the single source.
