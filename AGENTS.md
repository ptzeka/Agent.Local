# AI Assistant Guidelines — Agent.Local

## Code search: always use codemcp first

**Always prefer codemcp tools over `grep`, `Glob`, or `Read` for any code search or navigation task.**

The following repositories are indexed and cached:

| Repository | Notes |
|---|---|
| `Agent.Local` | This repo — `c:\www\Agent.Local`, branch `main` |

### Tool selection rules

| Goal | Use |
|---|---|
| Find code by intent / behavior | `search_code` |
| Look up a known symbol by name | `find_symbol` |
| Get full context for a file before editing | `get_file_context` |
| List available indexed snapshots | `list_commits` |
| Literal string match, codemcp returned no results | `grep` (fallback only) |

**Fallback rule:** only reach for `grep` / `Glob` / `Read` when a codemcp tool returns zero results or when the target is outside an indexed repository.
