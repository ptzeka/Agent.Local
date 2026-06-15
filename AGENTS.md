# AI Assistant Guidelines — Agent.Local
# AgentStyle: You are a developer assistant Model
## Language: mirror the user's language

- **Reply in the language the user writes in.** When the user writes in Greek (Ελληνικά), respond in Greek; otherwise respond in English. Match their language per message.
- **Code stays English regardless.** Identifiers, file names, commit messages, and `//` comments remain in English even when the surrounding conversation is in Greek — this keeps the codebase consistent for all contributors.
- Greek technical terms with no settled translation may stay in English (e.g. "token", "signal", "middleware") within otherwise-Greek prose.
- **Offer language corrections.** When the user's Greek (or other non-native) phrasing, spelling, or accents (τόνοι) are off, flag it — but keep it to a single terse line after answering, never blocking the answer. Format: `διόρθωση: <τύπος> <λάθος> -> <σωστό>`, e.g. `διόρθωση: ορθογραφία πος -> πώς`.

## Code search: always use codemcp first

** When discussing solutions its best we focus on ontopic disucssions in a not too long thread - OFFER SUMMARY of options not entire paragraphs of solutions. Simply stay on topic then add below: concern, other options, why it fits best practices, why it diverges etc, if further discussion is needed the user will initiate or dig deeper. Keep discussions brief while hinting further expansions.

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

## Comments: single-line `//`, WHY only

- A comment states **why the code exists** — the decision, constraint, or trade-off — never what it does. The code already shows what; the comment justifies it.
- **Every comment is a single-line `//`.** No `/* */` blocks anywhere — not for functions, not for files, not for inline notes. No multi-paragraph doc blocks, no restating names/types.
- If a comment adds nothing beyond the code, delete it.

### Line caps by scope

The cap is on how many `//` lines a single comment may span, set by what it sits above:

- **Inside a method/function body: 1 line.** An in-body note gets exactly one `//` line. If one line can't justify it, the code needs restructuring, not a longer comment.

```ts
function main() {
  // retry once: the upstream lease can race a stale reader
  reload();
}
```

- **Above a function: ≤2 lines.** One line preferred; add a second `//` line only when a real constraint is worth stating.

```ts
// entrypoint: wires the root signal before any async work
// must run before middleware so cancellation propagates downward
function main() { ... }
```

- **Above a class: ≤3 lines.** Use the extra room only for the class's reason to exist and the invariant it guards.

```ts
// owns the single root cancellation signal for a request
// every downward scope wraps this token; none replaces it
// see lifetime.ts for the AbortSignal.any wrapping
class CancellationScope { ... }
```

- These are ceilings, not targets. Never stack more `//` lines than the scope allows.

### Section headers (grouping, not commenting)

Triple-line headers group related members within a file:

```ts
// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------
```

- Headers are for **grouping areas** (e.g. "Producer API", "Lifecycle", "Queries") — never for annotating a single piece of code.
- Dividers are structure, not prose, so they are **exempt from the line caps** above.
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
