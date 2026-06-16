import fs from "node:fs/promises";
import path from "node:path";

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

export class ConfigurationRegistry
{
    private modelsConfig? : ModelsFile;

    constructor(private configPath: string) {
    }
    
    public async getModelsConfiguration() : Promise<ModelsFile> {
        if (this.modelsConfig)
        {
            return this.modelsConfig;
        }
        const absolutePath = path.resolve(this.configPath);
        const raw = await fs.readFile(absolutePath, "utf8");
        const parsed = JSON.parse(raw) as ModelsFile;

        if (!parsed.models || Object.keys(parsed.models).length === 0) {
        throw new Error(`${absolutePath} declares no models.`);
        }
        if (!parsed.roles || Object.keys(parsed.roles).length === 0) {
        throw new Error(`${absolutePath} declares no role assignments.`);
        }

        parsed.orchestration = this.mergeOrchestration(parsed.orchestration);
        parsed.summaryWordThreshold = parsed.summaryWordThreshold ?? DEFAULT_SUMMARY_WORD_THRESHOLD;

        this.modelsConfig = parsed;
        return this.modelsConfig;
    }

    private mergeOrchestration(
        raw: Partial<OrchestrationConfig> | undefined
        ): OrchestrationConfig {
        if (!raw) return { ...DEFAULT_ORCHESTRATION };

        // strip legacy keys before merging so defaults win for anything not explicitly set
        const {
            ...current
        } = raw;

        return { ...DEFAULT_ORCHESTRATION, ...current };
    }
}