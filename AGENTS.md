# AI Assistant Guidelines — Agent.Local
# AgentStyle: You are a developer assistant Model
## Language: mirror the user's language

- **Reply in the language the user writes in.** When the user writes in Greek (Ελληνικά), respond in Greek; otherwise respond in English. Match their language per message.
- **Code stays English regardless.** Identifiers, file names, commit messages, and `//` comments remain in English even when the surrounding conversation is in Greek — this keeps the codebase consistent for all contributors.
- Greek technical terms with no settled translation may stay in English (e.g. "token", "signal", "middleware") within otherwise-Greek prose.
- **Offer language corrections.** When the user's Greek (or other non-native) phrasing, spelling, or accents (τόνοι) are off, flag it — but keep it to a single terse line after answering, never blocking the answer. Format: `διόρθωση: <τύπος> <λάθος> -> <σωστό>`, e.g. `διόρθωση: ορθογραφία πος -> πώς`.

## BACKLOG
Use BACKLOG.md for backlog management and BACKLOG.DONE.md for done stories

## Skills: reusable runbooks live in `.claude/skills/`

This repo ships project skills under `.claude/skills/<name>/SKILL.md`. Consult them
**before** improvising the same task by hand, and keep one current after a refactor that
changes its paths/schema/commands (a stale runbook is worse than none):

| Skill | Use when |
|---|---|
| `debug-work` | Tracing one work/job by id — wrong status, missing file, a step didn't run, a dispatch misbehaved. Covers the host `work`/`work_agent_session`/`work_temporal` tables, agent session+conversation, workspace, logs, and host/agent/Temporal health. |
| `install-mcp-servers` | Installing/registering the agent.tools MCP servers (codemcp + memomcp, from `c:\www\agent.tools`) into the global Claude (`~/.claude.json`) / Cursor (`~/.cursor/mcp.json`) configs. |
| `solid` | Writing or reviewing code against the project's SOLID conventions — where logic lives, second implementations behind interfaces, DI via registries/Runtime. |
| `readability` | Making code speak for itself — naming functions/returns/variables so the call site reads as a sentence and the comment can be deleted. The naming half of `## Comments`. |

Invocation is by exact name (`/debug-work`) when surfaced as a slash command; otherwise
the file is the canonical reference — read it and follow its inline queries.

## Logs: where to find them

`npm start` runs the auth service + host + agent in the background and redirects each process's stdout/stderr to
a file under `scripts/.run/` (PIDs land next to them as `*.pid`). The agent REPL/CLI logs elsewhere because it
owns the terminal. When debugging traffic, read these first:

| Source | Location | Notes |
|---|---|---|
| Auth **service** (`/account/*`, `/connect/token`, JWKS) | `scripts/.run/auth.log` | console-backed logger; all `[auth]` lines — login, token issuance, JWKS verification |
| Host (incl. Temporal **worker**) | `scripts/.run/host.log` | host stdout; the Temporal worker runs in-process, so its activation/workflow logs are here too |
| Agent **server** (`/events`, `/receive`, webhooks) | `scripts/.run/agent.log` | console-backed logger; all `[agent-server]` lines |
| Agent **CLI / REPL** | `logs/agent-<MDYYYY>.log` | `FileLogger`, out-of-band so the REPL prompt stays clean; new file per day; override path with `AGENT_LOG_FILE` |
| Temporal **server** | `docker logs agent-local-temporalhost` | container, not a repo file; from `src/temporalhost` compose |

- Verbosity: `LOG_LEVEL=error|warn|info|debug` (or `DEBUG=1` for debug); defaults to `info`.
- The `host-client → agent /events` and `agent-server → host /receive` round-trip is the comms path — the host
  side shows in `host.log`, the agent side in `agent.log`. Read both to see one request end-to-end.

## Decisions & preferences: persist in-repo, not global memory

Persist decisions, conventions, and preferences as **repo artifacts** — backlog
decisions in BACKLOG.md, behavioral rules here in AGENTS.md, reusable know-how as
a local skill/rule. **Do not write to global memory** for this project.

### Agent memory: `memomcp` takes precedence over Claude's global auto-memory

This project uses the agent.tools memory server, `memomcp` (`mcp__memomcp__remember` /
`recall` / `recall_expand` / `recall_locate`), for agent-memory-shaped facts —
who the user is, standing preferences, running context worth recalling across
sessions. When that kind of fact comes up:

- **Save it via `memomcp`, never Claude Code's global auto-memory** (the
  `~/.claude/projects/**/memory/MEMORY.md` file-based system). That system is
  for cross-project assistant memory; this repo's own memory belongs in its own
  memory store so it stays scoped to this project and queryable by any agent
  hitting the MCP server, not just Claude Code.
- If `memomcp` tools aren't registered in the current session, say so and ask
  before falling back to anything else — don't silently write to global memory
  as a substitute.
- Decisions/conventions still go to BACKLOG.md/AGENTS.md/skills per above;
  `memomcp` is specifically for memory-shaped facts (identity, preference,
  recall-later context), not process or architecture decisions.

## Code search: always use codemcp first

** When discussing solutions its best we focus on ontopic disucssions in a not too long thread - OFFER SUMMARY of options not entire paragraphs of solutions. Simply stay on topic then add below: concern, other options, why it fits best practices, why it diverges etc, if further discussion is needed the user will initiate or dig deeper. Keep discussions brief while hinting further expansions.

**Always prefer codemcp tools over `grep`, `Glob`, or `Read` for any code search or navigation task.**

The following repositories are indexed and cached:

| Repository | Notes |
|---|---|
| `Agent.Local` | This repo — `/Applications/WWW/Agent.Local`, branch `main` |


### Tool selection rules

| Goal | Use |
|---|---|
| Find code by intent / behavior | `search_code` |
| Look up a known symbol by name | `get_symbol` |
| Who calls / imports / implements / extends X | `get_relationships` |
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

## Economy: reuse over proliferation

Be economical with the number of functions, classes, and instances. Before adding a
new one, look for a **semantic** reuse of what already exists — extend, parameterise,
or compose an existing abstraction rather than spawning a parallel one that clutters
the surface.

- **Prefer one configurable thing over two near-duplicates.** If a new need differs
  only by data (a whitelist, a flag, a descriptor), drive it with that data, not a new
  class. (The fs read-only server is the model: one tool catalog, a deterministic
  filter — not a second hand-written server.)
- **Reuse must be semantic, not incidental.** Share code only where the concepts truly
  coincide; don't fold two unrelated things into one just to save a line. Forced reuse
  is its own kind of clutter.
- **A new abstraction must earn its place.** Add a class/instance when it carries a
  distinct responsibility or invariant, not as the default reflex for "more behaviour".
