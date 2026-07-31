import type { ModelsFile } from "../registries/configuration-registry.js";
import type { ModelRegistry } from "../registries/model-registry.js";

// the loop's per-turn knobs, all sourced from the role's data record — a new kind of turn is a role
// record, never another branch inside the loop
export interface TurnProfile {
  readonly role: string;
  readonly maxIterations: number;
  readonly temperature: number;
  // coordinator roles bind the turn-scoped servers (dispatch tracker / result sink); leaf sub-agents don't
  readonly needsTurnBinding: boolean;
  // completion contract name → policy (self-terminate | tool-evidence | structured-verdict)
  readonly completion: string;
  // run the terminal evaluator pass after the turn settles (stamps a PASS/FAIL/INCOMPLETE verdict)
  readonly evaluatorPass: boolean;
}

export interface ResolveProfileParams {
  role: string;
  config: ModelsFile;
  modelsRegistry: ModelRegistry;
}

// the ONE place a role is read, and it reads the record's FIELDS — never the role name
export function resolveTurnProfile(params: ResolveProfileParams): TurnProfile {
  const { role, config, modelsRegistry } = params;
  const def = modelsRegistry.getRoleDefinition(role);

  return {
    role,
    maxIterations: def.maxIterations ?? 16,
    temperature: def.temperature ?? 0.2,
    // a dispatchable role is a leaf sub-agent; a non-dispatchable role coordinates and binds
    needsTurnBinding: !def.dispatchable,
    completion: def.completion,
    // never on a dispatchable (leaf) role, else the evaluator would recursively evaluate itself
    evaluatorPass: !def.dispatchable && !!config.orchestration.evaluatorEnabled,
  };
}
