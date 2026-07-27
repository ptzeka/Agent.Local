import type { ModelsFile } from "../registries/configuration-registry.js";
import type { ModelRegistry } from "../registries/model-registry.js";

// every per-role behavioural difference of the loop expressed as data, so a new kind of turn is a
// profile rather than another branch inside the orchestrator
// this is the ONLY place a role name is tested; everything downstream reads flags
export interface TurnProfile {
  readonly role: string;
  readonly maxIterations: number;
  readonly temperature: number;
  // the executor sub-run neither dispatches nor reports, so no server needs per-turn state bound for it
  readonly needsTurnBinding: boolean;
  // "is report_result mounted" — the executor reports to its parent, not a workflow, so it is excluded
  readonly structuredMode: boolean;
  // the executor's first tool-free reply IS the result; the orchestrator's goes to a gate
  readonly terminatesOnToolFreeReply: boolean;
  readonly evaluatorGated: boolean;
}

export interface ResolveProfileParams {
  role: string;
  config: ModelsFile;
  modelsRegistry: ModelRegistry;
  // whether the turn-result server is mounted at all; the profile decides if this role may use it
  structuredAvailable: boolean;
}

export function resolveTurnProfile(params: ResolveProfileParams): TurnProfile {
  const { role, config, modelsRegistry, structuredAvailable } = params;
  const orchestration = config.orchestration;
  const isExecutor = role === "executor";

  return {
    role,
    maxIterations: resolveIterationCap(role, isExecutor, config, modelsRegistry),
    temperature: (isExecutor ? orchestration.executorTemperature : orchestration.orchestratorTemperature)!,
    needsTurnBinding: !isExecutor,
    structuredMode: structuredAvailable && !isExecutor,
    terminatesOnToolFreeReply: isExecutor,
    evaluatorGated: !isExecutor && !!orchestration.evaluatorEnabled,
  };
}

// the model's own iterationCap wins; absent it, fall back to the role default
function resolveIterationCap(
  role: string,
  isExecutor: boolean,
  config: ModelsFile,
  modelsRegistry: ModelRegistry
): number {
  const roleDefault = isExecutor
    ? (config.orchestration.maxExecutorIterationsPerAsk ?? 6)
    : (config.orchestration.maxOrchestratorIterations ?? 16);
  const modelName = modelsRegistry.getProviderForRole(role);
  return modelsRegistry.getIterationCapForModel(modelName) ?? roleDefault;
}
