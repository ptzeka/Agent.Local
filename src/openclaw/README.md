# @agent-local/openclaw-runner

Workspace wrapper that runs the public [`openclaw`](https://www.npmjs.com/package/openclaw)
multi-channel AI gateway against this repo's local Ollama models and local MCP
servers (`fsmcp`, `codemcp`).

The name is deliberately scoped under `@agent-local/` to avoid collision with
the upstream `@openclaw/*` scope on npm (owned by `steipete`).

## Agent architecture

This runner is configured as a **coordinator + executor + sub-agents** system.
One small primary model plans and dispatches; a co-resident executor sub-agent
gates every action (APPROVE / REJECT); specialist sub-agents do the actual work
via openclaw's `sessions_spawn`. Each role is intentionally narrow so models
can't drift outside their lane.

```
                  ┌──────────────────┐
                  │   COORDINATOR    │ qwen2.5:7b  (~5 GB resident)
                  │  plan + decide   │ owns "what's next"
                  └────────┬─────────┘
                           │ proposes action
                           ▼
                  ┌──────────────────┐
                  │   EXECUTOR       │ qwen2.5:7b  (same model, separate role)
                  │ APPROVE / REJECT │ owns "should we do this?"
                  └────────┬─────────┘
                           │ if APPROVE
                           ▼
       ┌──────────────┬────┴────┬────────────────────┐
       ▼              ▼         ▼                    ▼
  ┌─────────┐  ┌────────────┐ ┌──────────────┐
  │ CODER   │  │ VALIDATOR  │ │ TOOLCHAIN    │
  │ qwen2.5 │  │ deepseek-r1│ │ llama3.2:3b  │
  │ -coder  │  │ :14b       │ │ (~2 GB)      │
  │ :14b    │  │ reasoning  │ │              │
  └─────────┘  └────────────┘ └──────────────┘
   ~9 GB        ~9 GB           ~2 GB
   writes       judges          introspects
```

### Roles

| Role | Model | VRAM | Tools | Decides | Output |
|---|---|---|---|---|---|
| **Coordinator** | `qwen2.5:7b` | ~5 GB | `sessions_spawn`, file reads | what to do next | plan + delegations |
| **Executor** | `qwen2.5:7b` | (same) | none beyond reading the ask | yes/no on the *current* ask | one-line verdict |
| **Coder** | `qwen2.5-coder:14b` | ~9 GB | full fsmcp + codemcp | how to implement the chunk | code changes + diff |
| **Validator** | `deepseek-r1:14b` | ~9 GB | none (no tool calls) | did the work succeed? | PASS / FAIL / INCOMPLETE |
| **Toolchain** | `llama3.2:3b` | ~2 GB | read-only introspection | n/a | structured lists |

### Coordinator vs Executor vs Validator

These three are not the same job:

- **Coordinator** does **all** planning — what to do next, how to recover from
  rejections, when to stop and ask the user.
- **Executor** is a pure yes/no oracle on the **current** proposed action.
  It does not plan, does not propose alternatives, does not retry on its own.
- **Validator** judges work **after** it's done (PASS / FAIL on completion).
  Executor judges **before** (APPROVE / REJECT to even attempt it).

The coordinator/executor split exists for two reasons. **Safety:** every
non-trivial action gets a second-opinion check from a separate session before
it runs. **Reliability:** splitting "plan" from "approve-and-execute" lets the
7B coordinator stay in text/planning mode (its strength) while a separate
executor session handles the structured tool-call discipline.

### VRAM math (16 GB total)

Coordinator + Executor share the same model (qwen2.5:7b, ~5 GB resident — one
weights file, two sessions). Toolchain (~2 GB) co-resides. That's **~7 GB
resident**, leaving **~9 GB** for one 14 B specialist sub-agent at a time.
Coder and validator never run concurrently — the coordinator schedules them
sequentially (write, then review).

### Why each model

- **`qwen2.5:7b` for coordinator and executor** — small enough to stay warm,
  strong Ollama tool-calling, good planning. Ollama's bare `qwen2.5:7b` tag
  *is* the instruct variant; there is no separate `qwen2.5:7b-instruct` short
  tag. Notably *not* the `-coder` variant: the coder fine-tune emits markdown
  JSON instead of structured tool calls, which is fine when writing code, bad
  when orchestrating it. The executor reuses the same weights as the
  coordinator — one model file, two separate sessions, no extra VRAM.
- **`qwen2.5-coder:14b` for coder** — what it was built for. Excels at editing
  existing code, refactoring, and following conventions in a repo.
- **`deepseek-r1:14b` for validator** — reasoning model. Its `<think>` step is
  exactly what review needs ("is each requirement met?"). Different model
  family from coder so the two don't share blind spots. Tool-calls aren't
  reliable on R1 distills, but that's a feature here — the validator can't
  change anything, only judge.
- **`llama3.2:3b` for toolchain** — meta queries ("list MCPs", "what tools
  do you have") are mechanical lookups. A 3 B is plenty. Solid Ollama tool
  template. Co-resides with the coordinator without VRAM pressure.

### Loop

1. Coordinator presents a plan → user approves.
2. For each chunk:
   1. Coordinator consults **Executor**: "spawn Coder to do X" → `APPROVE` / `REJECT`.
   2. If approved → Coordinator spawns **Coder**. Coder edits files via MCP.
   3. Coordinator gathers evidence (diff + touched files + their callers).
   4. Coordinator consults **Executor**: "spawn Validator with this evidence" → verdict.
   5. If approved → Coordinator spawns **Validator** with the evidence + original task.
   6. Validator emits a verdict (`PASS` / `FAIL` / `INCOMPLETE` + reasoning).
3. **On disagreement, executor REJECT, or validator FAIL/INCOMPLETE: coordinator
   STOPS and surfaces all sub-agent outputs to the user.** No auto-retry. No
   silent re-spawn.
4. Any "what's available?" question is delegated to **Toolchain** instead of
   the coordinator burning context on introspection (after an Executor consult).

The coordinator's full operating instructions live in
[`../context/agentcontext.md`](../context/agentcontext.md) and are synced into
the workspace as `AGENTS.md` on `npm run build` (see *Project context sync*
below).

## Configuration

All openclaw state lives **inside this workspace**, not in your home directory:

```
src/openclaw/.openclaw/
├── openclaw.json     # config (models, providers, MCP servers, gateway)
├── agents/           # per-agent state and sessions
├── logs/             # gateway logs
├── plugins/          # generated plugin registry (do not edit)
├── plugin-skills/    # installed skills (e.g. browser-automation)
└── workspace/        # default agent workspace (AGENTS.md lives here)
```

`OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR` are set in every npm script
(see `package.json`). Invoking the global `openclaw` CLI from elsewhere will
use the default `~/.openclaw/` location — always go through the npm scripts.

### Key config sections in `openclaw.json`

- `agents.defaults.model.primary` — coordinator model
  (`ollama/qwen2.5:7b`).
- `agents.defaults.subagents.delegationMode: "prefer"` — injects a system-prompt
  section telling the coordinator to delegate anything non-trivial through
  `sessions_spawn` rather than doing it itself.
- `agents.defaults.subagents.runTimeoutSeconds` — per-spawn timeout (default
  600 s).
- `models.providers.ollama.models[]` — model registry. Each entry sets
  `compat.supportsTools` so the runtime knows whether to advertise tool
  schemas. `deepseek-r1:14b` is intentionally `supportsTools: false`.
- `tools.profile: "coding"` — exposes `sessions_spawn`, file tools, etc.
- `mcp.servers` — `fsmcp` and `codemcp` server definitions.

## Project context sync

The canonical agent direction file is [`src/context/agentcontext.md`](../context/agentcontext.md).
It's the single source of truth.

openclaw's bootstrap injection only reads a fixed set of filenames from the
workspace (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, etc.). So a small build step
copies `agentcontext.md` → `.openclaw/workspace/AGENTS.md` with a generated
header. This happens automatically on `npm run build` (via `postbuild` →
`sync:context`), or manually with `npm run sync:context`.

Override the source path with `AGENT_CONTEXT_FILE` (same convention as the
older `src/agent` loader).

## Prerequisites

- Node ≥ 22.19 (openclaw enforces this hard at startup).
- [Ollama](https://ollama.com) running locally with **all four models** pulled:
  ```bash
  ollama pull qwen2.5:7b    # coordinator
  ollama pull qwen2.5-coder:14b      # coder
  ollama pull deepseek-r1:14b        # validator
  ollama pull llama3.2:3b            # toolchain
  ```
- Both MCP servers built:
  ```bash
  npm run build -w @agent-local/fsmcp -w @agent-local/codemcp
  ```

## Scripts

| Command | What it does |
|---------|--------------|
| `npm start -w @agent-local/openclaw-runner` | Open the local terminal UI (alias for `chat`) |
| `npm run chat -w @agent-local/openclaw-runner` | Same as `start` |
| `npm run gateway -w @agent-local/openclaw-runner` | Run the gateway daemon (foreground) |
| `npm run status -w @agent-local/openclaw-runner` | Show gateway/channel/model status |
| `npm run doctor -w @agent-local/openclaw-runner` | Diagnose and offer fixes for config issues |
| `npm run update -w @agent-local/openclaw-runner` | Run openclaw's self-update flow (rotates `.pre-update` backup) |
| `npm run configure -w @agent-local/openclaw-runner` | Interactive config tweak |
| `npm run validate -w @agent-local/openclaw-runner` | Validate config against schema |
| `npm run models:list -w @agent-local/openclaw-runner` | List configured models |
| `npm run mcp:list -w @agent-local/openclaw-runner` | List configured MCP servers |
| `npm run build -w @agent-local/openclaw-runner` | TypeScript build + sync context (`postbuild` runs `sync:context`) |
| `npm run sync:context -w @agent-local/openclaw-runner` | Copy `src/context/agentcontext.md` → `.openclaw/workspace/AGENTS.md` |
| `npm run onboard -w @agent-local/openclaw-runner` | Re-run non-interactive onboard |

## Verifying the agent loop

Inside a `chat` session, use openclaw's built-in slash commands:

- `/status` — current model, gateway state, session token usage.
- `/context list` — what got injected as **Project Context**. Confirm
  `AGENTS.md` shows non-zero size and the right content.
- `/context detail` — `Tool schemas (JSON)` size should be non-zero. If it's
  zero, tools aren't being sent to the model and sub-agent dispatch will fail.
- `/subagents list` — sub-agent runs spawned in this session.

If the coordinator emits tool calls as plain JSON text instead of executing,
see *Troubleshooting tool calls* below.

## Troubleshooting tool calls

If a model prints `{"name": "tool_x", "arguments": {...}}` as visible text
instead of actually invoking the tool, the runtime never received a
structured call. Common causes:

1. **Wrong model.** Coder fine-tunes (e.g. `qwen2.5-coder:14b`) are biased
   toward emitting markdown code blocks and will sometimes render tool calls
   as JSON prose. Use the instruct variant for coordination roles.
2. **Tool block missing from chat template.** Check with:
   ```powershell
   ollama show <model> --template | Select-String -Pattern "Tools|tool_call"
   ```
   If there's no `{{- if .Tools }}` block, the model can't see tool schemas
   and is hallucinating calls in text. Re-pull or switch model.
3. **No tools advertised.** `/context detail` shows zero tool schema bytes →
   MCP servers failed to start or the tools profile didn't load. Run
   `npm run mcp:list` and `npm run doctor`.

## Re-bootstrapping from scratch

If `.openclaw/openclaw.json` is ever deleted or corrupted:

```bash
npm run onboard -w @agent-local/openclaw-runner
```

This runs `openclaw onboard --non-interactive --accept-risk --mode local
--flow quickstart --auth-choice ollama` and recreates a working baseline.
You'll then need to redo the customizations:

```bash
# Re-set coordinator model
npm run _oc -w @agent-local/openclaw-runner -- config set agents.defaults.model.primary ollama/qwen2.5:7b

# Re-enable sub-agent delegation
npm run _oc -w @agent-local/openclaw-runner -- config set agents.defaults.subagents.delegationMode prefer

# Re-register MCP servers
npm run _oc -w @agent-local/openclaw-runner -- mcp set fsmcp '{"command":"node","args":["C:/www/Agent.Local/src/fsmcp/dist/server.js"],"env":{"AGENT_WORKSPACE":"."}}'
npm run _oc -w @agent-local/openclaw-runner -- mcp set codemcp '{"command":"node","args":["C:/www/Agent.Local/src/codemcp/dist/server.js","--backend","file"]}'

# Re-sync project context
npm run sync:context -w @agent-local/openclaw-runner
```
