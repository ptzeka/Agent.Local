# Agent.Local

A local coding agent powered by [Ollama](https://ollama.com), built in TypeScript
with a multi-agent orchestration loop (planner + executor) and MCP-based tools.

Everything runs on your machine. No cloud calls.

---

## Architecture

```
┌──────────────────────────┐
│  CLI REPL (src/cli)      │  user input, slash commands, rendering
├──────────────────────────┤
│  Orchestrator            │  planner phase → executor loop → tool sync
│  (src/agent)             │
│   ├─ ModelRegistry       │  role → LLMProvider, hot-swappable
│   ├─ Providers           │  Ollama today; pluggable interface
│   ├─ McpToolClient       │  spawns MCP servers, dispatches tool calls
│   └─ ToolAdapter         │  native function calls OR prompted JSON fallback
├──────────────────────────┤
│  MCP Tools Server        │  child node process, stdio transport
│  (src/tools)             │   ├─ read_file, write_file, edit_file, list_dir
│                          │   └─ glob, grep
└──────────────────────────┘
```

The three layers only call downward, per the project's architectural guidelines:
UI → Services → Repository/External.

---

## Two-agent flow per user turn

1. **Planner** (a reasoning model like `deepseek-r1`) reads the user request and
   produces an ordered plan. No tools. `<think>` blocks are stripped.
2. **Executor** (a tool-calling model like `qwen2.5-coder`) receives the plan
   as a system message and runs an iterative tool-call loop against the MCP server
   until it produces a final answer.
3. The conversation history is preserved across turns. Use `/think off` to skip
   the planner phase for quick questions.

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


