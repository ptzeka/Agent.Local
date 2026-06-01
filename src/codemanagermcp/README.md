# codemanagermcp

Model Context Protocol server that exposes **workflow verbs** for AI-driven feature development. An AI agent uses these five tools to move a feature through a defined state machine — without ever touching raw git commands or deployment scripts directly.

```
start_feature  →  push_changes  →  accept_changes  →  (human security review)
                        ↑_____________________|  (if tests fail: fix + retry)
abandon_changes  (at any point, if the feature is scrapped)
```

Based on the [agent-dev-flow](../../specs/agent-dev-flow.md) spec: verbs are **intents**, not mechanisms. Wrong actions are unrepresentable — the agent can't accidentally push to main, destroy the wrong env, or create PRs with broken tests without knowing about it.

## Build

```bash
cd tools/codemanagermcp
npm install
npm run build
```

Produces `dist/server.js`.

## Configure

Configuration is split across two layered files in the same directory as `server.js` (i.e. `tools/codemanagermcp/`):

| File | Purpose |
|---|---|
| `appsettings.json` | Base / dev settings. Safe to commit (no secrets). |
| `release.json` | Production overlay. Wins on every key it defines. Inject at runtime or add to `.gitignore`. |

At least one file must exist. Only include keys in `release.json` that differ from `appsettings.json`.

```bash
cp tools/codemanagermcp/appsettings.example.json tools/codemanagermcp/appsettings.json
cp tools/codemanagermcp/release.example.json     tools/codemanagermcp/release.json
```

**`appsettings.json`** (dev base — no secrets):

```json
{
  "repositoryPath": "C:/absolute/path/to/your/local/clone",
  "mainBranch": "main",
  "branchPrefix": "feat/",
  "azureDevOps": {
    "organization": "MyOrg",
    "project":      "MyProject",
    "repository":   "MyRepo",
    "apiKeyFile":   "./secrets/ado-token.txt"
  },
  "pipelines": {
    "deployPipelineId": 10,
    "ciPipelineId":     12,
    "deletePipelineId": 11,
    "ciTimeoutMinutes": 15
  }
}
```

**`release.json`** (production overlay — injected at build/execution time):

```json
{
  "azureDevOps": {
    "organization": "MyOrg",
    "project":      "MyProject",
    "repository":   "MyRepo"
  },
  "pipelines": {
    "deployPipelineId": 10,
    "deletePipelineId": 11,
    "ciPipelineId":     12,
    "ciTimeoutMinutes": 20
  }
}
```

### Config fields

| Field | Required | Default | Notes |
|---|---|---|---|
| `repositoryPath` | yes | — | Absolute path to the local git clone. |
| `mainBranch` | no | `"main"` | Branch PRs target and features branch from. |
| `branchPrefix` | no | `"feat/"` | Prepended to the slugified feature name. |
| `azureDevOps.organization` | yes | — | ADO organisation (appears after `dev.azure.com/`). |
| `azureDevOps.project` | yes | — | Team project name. |
| `azureDevOps.repository` | yes | — | Repository name as shown in ADO. |
| `azureDevOps.apiKeyFile` | no | — | Path (relative to config dir) to a plain-text file with a PAT. For local dev. Falls back to `AZURE_DEVOPS_TOKEN` env var. |
| `pipelines.deployPipelineId` | yes | — | Pipeline definition ID for ephemeral env deploy. Triggered by `start_feature` + `push_changes`. |
| `pipelines.ciPipelineId` | yes | — | Pipeline definition ID for CI (build + tests). Triggered by `accept_changes`. |
| `pipelines.deletePipelineId` | no | — | Pipeline definition ID for env teardown. Triggered by `abandon_changes` + `accept_changes`. |
| `pipelines.ciTimeoutMinutes` | no | `15` | Max minutes to wait for CI pipeline before timing out. |

### Token resolution (priority order)

1. `AZURE_DEVOPS_TOKEN` environment variable — set in shell or injected by Azure Pipelines.
2. `azureDevOps.apiKeyFile` contents — path relative to the config dir, for local dev.

In Azure Pipelines, inject the PAT as a secret pipeline variable named `AZURE_DEVOPS_TOKEN` and omit `apiKeyFile`. The server will find it via the env var.

### Pipeline variables passed on every run

Each pipeline triggered by codemanagermcp receives these variables:

| Variable | Example value |
|---|---|
| `BRANCH_NAME` | `feat/add-user-auth` |
| `BRANCH_SLUG` | `add-user-auth` |
| `FEATURE_NAME` | `add user auth` |

Use them in your pipeline YAML to parameterise deployments, namespaces, hosting channels, etc.

## Wire into Cursor

```powershell
# From the repo root:
pwsh -File tools/codemanagermcp/install-mcp.ps1
```

This upserts `codemanagermcp` under `mcpServers` in `~/.cursor/mcp.json`, sets `cwd` to `tools/codemanagermcp` so the config file resolves predictably, then reload MCP in Cursor.

## Invocation

```
node dist/server.js [options] <command>
```

### Global options

| Flag | Default | Notes |
|---|---|---|
| `--config-dir <dir>` | cwd | Directory containing `appsettings.json` and/or `release.json`. |
| `--repository-path <path>` | from config | Override `repositoryPath` without editing config files. |

### Commands

| Command | Description |
|---|---|
| `serve` (default) | Start the stdio MCP server. |
| `probe <tool> [argsJson]` | Invoke a single tool from the command line (debugging). |
| `tools` | List all tools and their schemas. |

**PowerShell probe example:**

```powershell
node dist/server.js probe get_status '{}'
node dist/server.js probe start_feature '{\"name\":\"my-feature\"}'
```

## Tool reference

### `start_feature`

Creates a feature branch from main and deploys an ephemeral environment.

| Input | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Human name, e.g. `"add user auth"`. Auto-slugified. |

### `push_changes`

Stages, commits, and pushes working-tree changes to the active branch, then redeploys.

| Input | Type | Required | Notes |
|---|---|---|---|
| `message` | string | no | Commit message. Default: `"wip: {feature}"`. |
| `stageAll` | boolean | no | Run `git add -A` first. Default: `true`. |

### `accept_changes`

Ensures the branch is pushed, creates a GitHub PR (if a token is configured), runs the configured build + test commands, and returns detailed output. If tests fail, the tool returns the full output so the agent can fix and retry — **no human input required in the loop**.

| Input | Type | Required | Notes |
|---|---|---|---|
| `title` | string | no | PR title. Default: `"feat: {feature}"`. |
| `description` | string | no | PR body. |

### `abandon_changes`

Tears down the environment, deletes local + remote branch, clears state.

| Input | Type | Required | Notes |
|---|---|---|---|
| `force` | boolean | no | Override safety guard when a PR already exists. Default: `false`. |

### `get_status`

Returns current workflow state: active feature, branch, git working-tree status, last commit, and environment status.

No inputs required.

## State machine

```
(idle) ──start_feature──▶ (feature active)
                                │
                         push_changes (repeatable)
                                │
                         accept_changes ──▶ tests pass ──▶ (PR open, awaiting review)
                                │
                         tests fail ──▶ agent fixes ──▶ push_changes ──▶ accept_changes
                                │
                         abandon_changes ──▶ (idle)
```

State is persisted in `data/state.json` (next to the config file) so the server can be restarted mid-feature without losing context.

## Containment model

- **Credential scope**: the GitHub token in config is scoped to one repo. Cross-repo actions are impossible at the GitHub layer.
- **Verb surface**: tools are intents (`start_feature`, `accept_changes`), not mechanisms (`git push`, `kubectl apply`). Wrong actions are unrepresentable.
- **State machine**: each verb is a valid transition; the agent always knows where it is and what comes next.
- **Escalation**: if the agent is stuck it can call `get_status` to re-read state and reason about the next step.
