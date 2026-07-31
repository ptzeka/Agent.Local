import fs from "node:fs";
import path from "node:path";
import type { AgentServerSettings } from "../../server/appsettings.js";
import type { ToolOutputSchema } from "@agent-local/mcp/tooldescriptor";
import type { McpServerDef } from "../runtime/middleware/external-mcp.js";

// pure model configuration: how to reach a model and what it natively supports. How a role USES a model
// (tools, timeouts, caps) lives on the role, so one real model is one entry no matter how many roles share it
export interface ModelDefinition {
  provider: string;
  model: string;
  supportsTools: boolean;
  reasoning?: boolean;
  description?: string;
}

export const DEFAULT_TOOL_TIMEOUT_MS = 60000;

// the explicit shape a dispatchable role must return; it IS the dispatch tool's `outputSchema`, so the
// MCP client enforces it on every call and no tool body re-checks it. `report` is the one field the
// client has no use for — it templates the line stamped back into the PARENT conversation
export interface RoleReturnsSchema extends ToolOutputSchema {
  // template for the conversation line stamped after a dispatch settles; {field} / {field:upper} placeholders
  report?: string;
}

// the contract for calling a role as a sub-agent tool: what it does + the shape it returns
export interface RoleDispatch {
  description: string;
  returns?: RoleReturnsSchema;
}

// a role is a pure-data record: model, prompt, completion contract, and its behavioural knobs. This is the ONLY
// place role behaviour is declared — the runtime reads these fields, it never branches on a role NAME
export interface RoleDefinition {
  // an addressable model id from `models`
  model: string;
  // what this role is for; surfaced by /models, since the model entry no longer carries role wording
  description?: string;
  // prompt id resolved to a system prompt (see ModelRegistry.getPromptTemplate)
  prompt: string;
  // completion contract name → policy (self-terminate | tool-evidence | structured-verdict)
  completion: string;
  maxIterations?: number;
  temperature?: number;
  // omitted → DEFAULT_TOOL_TIMEOUT_MS; <= 0 disables the bound
  toolTimeoutMs?: number;
  // exposed as a sub-agent tool other roles can dispatch
  dispatchable?: boolean;
  // the MCP servers this role may mount; absent/empty advertises zero tools
  mcp?: string[];
  // OTHER roles this one may spawn as sub-agents, each mounted as `<role>__ask`. Separate axis from `tools`:
  // that grants MCP servers, this grants agents. An empty/absent list makes the role a leaf — the recursion bound
  agents?: string[];
  // the tool contract when this role is dispatched as a sub-agent
  dispatch?: RoleDispatch;
}


// turn-wide knobs only; anything per-role (iteration caps, temperatures) belongs to the role record
export interface OrchestrationConfig {
  maxExecutorDispatchesPerTurn: number;
  // per-turn completion judge; a guard rail for weaker models that self-verify poorly. Capable models can run
  // without it — set false to skip the gate so a tool-free turn settles as satisfied on the model's own word.
  evaluatorEnabled: boolean;
  // mid-flight progress check every N dispatches catches no-progress loops; set very high to disable
  validatorCheckIntervalDispatches: number;
  // compact the prefix past this many messages; lower = more summarizer calls, set very high to disable
  summarizeAtMessages: number;
  // recent messages kept verbatim after summarizing; a few more may stay to avoid splitting a tool pairing
  summarizerKeepLastN: number;
  // token ceilings counting own + delegated spend; 0 = unlimited. A breach cancels the turn's scope,
  // so it stops the live model call, its tools, and any child runtime through the one signal
  maxTokensPerTurn: number;
  maxTokensPerSession: number;
  // how long a settled request stays replay-able, so a re-delivered subsession/api request answers from
  // the record instead of re-running its side effects; 0 disables the executed ledger (pending-duplicate
  // dropping is always on — it is what collapses N identical child reports into one turn)
  idempotencyTtlMs: number;
}

const DEFAULT_ORCHESTRATION: OrchestrationConfig = {
  maxExecutorDispatchesPerTurn: 8,
  evaluatorEnabled: true,
  validatorCheckIntervalDispatches: 3,
  summarizeAtMessages: 30,
  summarizerKeepLastN: 8,
  // off by default: an existing models.json must not start capping turns on upgrade
  maxTokensPerTurn: 0,
  maxTokensPerSession: 0,
  idempotencyTtlMs: 0,
};


// requests shorter than this many words skip the evaluator gate (e.g. "ok", "thanks") and pass as satisfied
export const DEFAULT_SUMMARY_WORD_THRESHOLD = 2;

export interface ModelsFile {
  models: Record<string, ModelDefinition>;
  roles: Record<string, RoleDefinition>;
  orchestration: Partial<OrchestrationConfig>;
  summaryWordThreshold: number;
}

// the parsed, validated runtime config the registry serves. Built once at the edge (cli/server) and injected as
// an object — no file path crosses into the runtime, so the core stays host-agnostic and parses nothing lazily.
export interface RuntimeConfig {
  models: ModelsFile;
  settings: AgentServerSettings;
  // the mcpServers map from mcp.json; consumers spawn the named stdio servers
  mcpServers: Record<string, McpServerDef>;
}

function mergeOrchestration(raw: Partial<OrchestrationConfig> | undefined): OrchestrationConfig {
  // unknown keys fall away; defaults win for anything not explicitly set
  return { ...DEFAULT_ORCHESTRATION, ...(raw ?? {}) };
}

// edge loader: read + validate models.json into the in-memory ModelsFile. Validation lives here so a malformed
// config fails loudly at startup, not lazily mid-run deep in the runtime.
export function loadModelsFile(configPath: string): ModelsFile {
  const absolutePath = path.resolve(configPath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as ModelsFile;

  if (!parsed.models || Object.keys(parsed.models).length === 0) {
    throw new Error(`${absolutePath} declares no models.`);
  }
  if (!parsed.roles || Object.keys(parsed.roles).length === 0) {
    throw new Error(`${absolutePath} declares no role assignments.`);
  }

  parsed.orchestration = mergeOrchestration(parsed.orchestration);
  parsed.summaryWordThreshold = parsed.summaryWordThreshold ?? DEFAULT_SUMMARY_WORD_THRESHOLD;
  return parsed;
}

// holds the runtime config bundle and slices it to each consumer (models, appsettings, mcp servers). Constructed
// from already-parsed objects, so it does no file IO and the same instance is safe to reuse across sub-runtimes.
export class ConfigurationRegistry {
  constructor(private readonly config: RuntimeConfig) {}

  // async to keep the consumer contract stable, though the object is already in memory
  public async getModelsConfiguration(): Promise<ModelsFile> {
    return this.config.models;
  }

  public getAppSettings(): AgentServerSettings {
    return this.config.settings;
  }

  public getMcpServerDefs(): Record<string, McpServerDef> {
    return this.config.mcpServers;
  }
}
