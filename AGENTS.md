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

## Comments: 1–2 lines, WHY only

- A comment states **why the code exists** — the decision, constraint, or trade-off — never what it does.
- Hard cap: **1–2 lines.** If the WHY doesn't fit in two lines, the code needs restructuring, not a longer comment.
- No narrating behavior visible in the code, no multi-paragraph doc blocks, no restating names/types.
- If a comment adds nothing beyond the code, delete it.

### Section headers (grouping, not commenting)

Triple-line headers group related members within a file:

```ts
// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------
```

- Headers are for **grouping areas** (e.g. "Producer API", "Lifecycle", "Queries") — never for annotating a single piece of code.
- When a file uses headers, **respect them**: new members go under the matching header; add a new header section rather than appending out of place.
