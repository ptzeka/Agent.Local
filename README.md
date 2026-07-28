# Agent.Local

**A resilient agentic orchestrator.** A TypeScript coding agent built around one
configurable turn loop: any model provider, any host, role-scoped tools, and
extension points instead of forks.

Models are configuration, not code — run entirely local against
[Ollama](https://ollama.com), or point a role at Anthropic or Gemini. Mix them:
a cheap local model can execute while a stronger one orchestrates.

---

## What you get

**Core runtime** (this repo)

- **Multi-mode run** — the same runtime drives an interactive CLI REPL, an HTTP
  server (`/events`, `/receive`), or a headless single-shot run with meaningful
  exit codes for CI and job runners.
- **Configurable providers** — Ollama, Anthropic, and Gemini today, behind one
  `LLMProvider` interface. Roles map to models in `models.json` and hot-swap at
  runtime; native tool-calling and prompted-JSON models are both supported.
- **Extendable runtime** — the runtime is assembled by middleware into a DI
  container. Add a step, register a service, resolve it by token — no edits to
  the core.
- **Extendable turn** — the turn loop exposes four typed slots (context provider,
  compaction, context contributors, completion policy). Register one to change
  behaviour; leave it unset and the built-in default applies.
- **Role-based tool authorization** — a role sees only its whitelisted MCP
  servers. Tool access is resolved per role at turn assembly, never at the call
  site, so a role cannot reach a tool it was not granted.
- **Enforced turn semantics** — a dispatched turn must report a structured
  verdict, and an executor that produced prose without calling a single tool
  fails rather than banking a no-op.

**Platform** (sibling [Agent.Workflow](../Agent.Workflow) repo)

- Web console for authorized workflow and agent management
- Authentication service issuing the tokens this agent's role scoping trusts
- Temporal-backed durable task execution

Shared primitives (`@agent-local/common`) live in [Agent.Common](../Agent.Common);
the `codemcp` / `memomcp` MCP servers live in [agent.tools](../agent.tools).

---

## Architecture

```
┌────────────────────────────────┐
│  Hosts                         │  CLI REPL · HTTP server · headless run
├────────────────────────────────┤
│  AgentRuntime                  │  middleware-built DI container, one per session
│   ├─ Registries                │  models · providers · MCP · workspace · config
│   └─ Runner middleware         │  onion around every turn (metrics, counters)
├────────────────────────────────┤
│  TurnLoop                      │  gate → assemble → prologue → iterate → cap
│   ├─ Turn                      │  per-turn state, transcript, settled results
│   ├─ ModelCaller / ToolCaller  │  the loop's own steps — they decide nothing
│   └─ Policies                  │  context · compaction · contributors · completion
├────────────────────────────────┤
│  ScopedToolClient              │  role → whitelist → the only tools this turn sees
├────────────────────────────────┤
│  MCP servers                   │  fs, code search, memory — separate processes
└────────────────────────────────┘
```

Layers only call downward: hosts → runtime → loop → tools.

---

## Concepts

| Term | Meaning |
| --- | --- |
| **Turn** | One user request, start to finish. Owns its transcript and its settled result. |
| **Role** | Which job a model is doing — `orchestrator` plans and delegates, `executor` acts, plus `evaluator` / `summarizer` support roles. Roles map to models in `models.json`. |
| **Profile** | Every per-role difference expressed as data (iteration cap, temperature, which completion gate). Adding a kind of turn means adding a profile, not a branch in the loop. |
| **Policy** | A swappable decision: what context to build, when to compact, whether the turn is done. Exactly one policy may end a turn. |

---

## Prerequisites

- Node.js 20 or newer
- [Ollama](https://ollama.com/download) running locally
- The models referenced in `models.json`:
  ```bash
  ollama pull qwen2.5-coder:14b
  ollama pull deepseek-r1:14b
  ollama pull llama3.2:3b
  ```
  Smaller variants (`:7b`, `:3b`) work too — edit `models.json` to taste.

---

## Install and run

```bash
npm install
cp .env.example .env       # edit AGENT_WORKSPACE to your project path
npm run build
npm start
```

Or for live-reload development:

```bash
npm run dev
```

You should see:

```
Agent.Local — local coding agent (Ollama + MCP)
workspace: C:\path\to\your\workspace
planner phase: on (toggle with /think)
type /help for commands, /exit to quit

you (plan→exec)>
```

---

## REPL commands

| Command                       | Effect                                                                |
| ----------------------------- | --------------------------------------------------------------------- |
| `/help`                       | Show the command list.                                                |
| `/exit`                       | Quit the REPL.                                                        |
| `/reset`                      | Clear conversation history.                                           |
| `/think on` / `/think off`    | Toggle the planner phase.                                             |
| `/models`                     | List configured models and current role assignments.                  |
| `/model coder=qwen-coder`     | Reassign a role to a different model id from `models.json`.           |
| `/tools`                      | List every tool exposed by connected MCP servers.                     |
| `/history`                    | Print the current conversation transcript.                            |

---

## Configuration files

### `mcp.json`

Declares the MCP servers to spawn. The default config launches one server
that exposes the FS/search tools as a local node command:

```json
{
  "mcpServers": {
    "agent-tools": {
      "command": "node",
      "args": ["dist/tools/server.js"],
      "env": { "AGENT_WORKSPACE": "." }
    }
  }
}
```

You can add additional MCP servers (filesystem, search, your own) by appending
entries under `mcpServers`. The agent will auto-discover every tool they expose.

### `models.json`

Declares the models you have available and which role each one plays:

```json
{
  "models": {
    "qwen-coder":  { "provider": "ollama", "model": "qwen2.5-coder:14b", "supportsTools": true },
    "deepseek-r1": { "provider": "ollama", "model": "deepseek-r1:14b",   "supportsTools": false, "reasoning": true }
  },
  "roles": {
    "planner": "deepseek-r1",
    "coder":   "qwen-coder"
  }
}
```

Add a model: register it under `models`, then point a role at it.
Swap a model at runtime: `/model coder=llama-fast` in the REPL.

### `.env`

```ini
OLLAMA_HOST=http://localhost:11434
AGENT_WORKSPACE=.                              # absolute path is safer
AGENT_MAX_ITERATIONS=12
# AGENT_CONTEXT_FILE=src/context/agentcontext.md  # override the direction file
```

### Project direction file (`src/context/agentcontext.md`)

If `src/context/agentcontext.md` exists under the workspace root, its
contents are loaded once at startup and injected as a leading system message
to **both** the planner and the executor on every turn. This is the place
to put standing direction: coding conventions, architectural rules, what to
avoid, which folders matter.

The path is deliberately namespaced under `src/context/` so it doesn't
collide with other agent conventions like `AGENTS.md` or `CLAUDE.md`.

```markdown
# Project direction

- This repo is a ExpressJs + React 19 app. No Next.js patterns.
- All API calls go through `src/api/client.ts` — never `fetch` directly.
- Tests live next to the file as `*.test.ts`. No `__tests__` folders.
```

Override the path via `AGENT_CONTEXT_FILE` (absolute path, or relative to
`AGENT_WORKSPACE`). Missing files are silently ignored.

---

## Adding a new tool

1. Create a handler in `src/tools/fs/` or `src/tools/search/` with a Zod input
   schema and a typed result.
2. Register it in `src/tools/server.ts` via `defineTool({...})`.
3. Rebuild (`npm run build`). The agent will discover it on next startup.

## Adding a new LLM backend

1. Implement `LLMProvider` in `src/agent/providers/<name>-provider.ts`.
2. Add a case to `createProvider` in `src/agent/providers/index.ts`.
3. Reference it from `models.json` under `provider: "<name>"`.

---

## Safety notes

- All filesystem tools are confined to `AGENT_WORKSPACE`. Paths that resolve
  outside the workspace root are rejected before any disk access happens.
- There is no shell-execution tool in this build. Add one only with care.
- The MCP server runs as a separate process from the agent — useful for isolation
  and for letting other MCP-capable clients (Claude Desktop, etc.) reuse the same
  tool set.


