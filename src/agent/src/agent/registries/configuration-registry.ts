import fs from "node:fs/promises";
import path from "node:path";

export interface ModelDefinition {
  provider: string;
  model: string;
  supportsTools: boolean;
  reasoning?: boolean;
  description?: string;
  mcp?: string[];
}


export interface OrchestrationConfig {
  /** Hard cap on orchestrator LLM turns per user message. */
  maxOrchestratorIterations: number;
  /** Hard cap on dispatch_executor calls per user message. */
  maxExecutorDispatchesPerTurn: number;
  /** Hard cap on executor LLM turns per single dispatch. */
  maxExecutorIterationsPerAsk: number;
  orchestratorTemperature: number;
  executorTemperature: number;
  /** Sampling temperature for the evaluator (completion-gate) judge. */
  evaluatorTemperature: number;
  /**
   * Run the evaluator as a progress check every this-many successful
   * executor dispatches, not only at completion. Catches no-progress
   * loops mid-flight. Set very high to effectively disable.
   */
  validatorCheckIntervalDispatches: number;
  /**
   * Summarize the conversation prefix once it grows beyond this many
   * messages. Lower = more aggressive compaction, more summarizer LLM
   * calls. Set very high to effectively disable.
   */
  summarizeAtMessages: number;
  /**
   * After summarizing, keep this many recent messages verbatim. The
   * orchestrator may keep slightly more to avoid splitting a tool-call /
   * tool-result pairing.
   */
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


export interface ModelsFile {
  models: Record<string, ModelDefinition>;
  roles: Record<string, string>;
  orchestration: Partial<OrchestrationConfig>
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

        this.modelsConfig = parsed;
        return this.modelsConfig;
    }

    private mergeOrchestration(
        raw: Partial<OrchestrationConfig> | undefined
        ): OrchestrationConfig {
        if (!raw) return { ...DEFAULT_ORCHESTRATION };

        // Strip the legacy keys before merging.
        const {
            ...current
        } = raw;

        return { ...DEFAULT_ORCHESTRATION, ...current };
    }
}