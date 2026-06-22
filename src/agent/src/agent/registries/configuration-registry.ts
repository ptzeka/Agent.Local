import fs from "node:fs";
import path from "node:path";
import type { AgentServerSettings } from "../../server/appsettings.js";
import type { McpServerDef } from "../runtime/middleware/external-mcp.js";

export interface ModelDefinition {
  provider: string;
  model: string;
  supportsTools: boolean;
  reasoning?: boolean;
  description?: string;
  mcp?: string[];
  // omitted → DEFAULT_TOOL_TIMEOUT_MS; <= 0 disables the bound
  toolTimeoutMs?: number;
  // omitted → the role default (maxExecutorIterationsPerAsk / maxOrchestratorIterations)
  iterationCap?: number;
}

export const DEFAULT_TOOL_TIMEOUT_MS = 60000;


export interface OrchestrationConfig {
  maxOrchestratorIterations: number;
  maxExecutorDispatchesPerTurn: number;
  maxExecutorIterationsPerAsk: number;
  orchestratorTemperature: number;
  executorTemperature: number;
  evaluatorTemperature: number;
  // per-turn completion judge; a guard rail for weaker models that self-verify poorly. Capable models can run
  // without it — set false to skip the gate so a tool-free turn settles as satisfied on the model's own word.
  evaluatorEnabled: boolean;
  // mid-flight progress check every N dispatches catches no-progress loops; set very high to disable
  validatorCheckIntervalDispatches: number;
  // compact the prefix past this many messages; lower = more summarizer calls, set very high to disable
  summarizeAtMessages: number;
  // recent messages kept verbatim after summarizing; a few more may stay to avoid splitting a tool pairing
  summarizerKeepLastN: number;
}

const DEFAULT_ORCHESTRATION: OrchestrationConfig = {
  maxOrchestratorIterations: 16,
  maxExecutorDispatchesPerTurn: 8,
  maxExecutorIterationsPerAsk: 6,
  orchestratorTemperature: 0.2,
  executorTemperature: 0.1,
  evaluatorTemperature: 0.1,
  evaluatorEnabled: true,
  validatorCheckIntervalDispatches: 3,
  summarizeAtMessages: 30,
  summarizerKeepLastN: 8,
};


// requests shorter than this many words skip the evaluator gate (e.g. "ok", "thanks") and pass as satisfied
export const DEFAULT_SUMMARY_WORD_THRESHOLD = 2;

export interface ModelsFile {
  models: Record<string, ModelDefinition>;
  roles: Record<string, string>;
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
