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

### Function comments

- **1 line preferred** — a single `//` line above the function:

```ts
// this function is main entrypoint
function main() { ... }
```

- **2 lines max** — add a second `//` line only when there's extra worth stating:

```ts
// this function is main entrypoint
// sub description
function main() { ... }
```

- That's the ceiling: no endless comment stacks above a function.
- **Top-level functions** may carry a `/* */` summary block when a fuller overview is warranted:

```ts
/*
 * Summary of the top-level function: its role and why it exists.
 */
function bootstrap() { ... }
```

### Section headers (grouping, not commenting)

Triple-line headers group related members within a file:

```ts
// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------
```

- Headers are for **grouping areas** (e.g. "Producer API", "Lifecycle", "Queries") — never for annotating a single piece of code.
- When a file uses headers, **respect them**: new members go under the matching header; add a new header section rather than appending out of place.

## Cancellation & timeouts: one signal from the source, wrapped downward

There is exactly **one root signal per request**, minted at the source — the CLI's
root `AbortController` (`cli/index.ts`) / the start of a request — and threaded
down as `deps.parentSignal`. Never mint a fresh root signal partway down the chain.

- **Propagate, don't replace.** A scope that needs its own cutoff wraps the
  incoming signal in a `CancellationToken` (`common/lifetime.ts`), which is
  `AbortSignal.any([parent, own])`. Cancelling cuts that scope **and everything
  below it**, never the parent — so the whole downward chain collapses on cancel.
- **A timeout is just a cancel.** Don't race promises for deadlines. Start a timer
  that calls `token.cancel(...)`; hand `token.signal` further down. The MCP servers
  own their per-model tool timeout (injected once at construction via the chainable
  `Mcp.setTimeout`); `ScopedToolClient` only routes and forwards the turn's signal.
- **Tools observe, never originate.** A `LocalTool.invoke` receives a
  `CancellationToken` (`cutoffscope`); honour `cutoffscope.signal` to stop early.
  A tool must not create its own root cutoff.
