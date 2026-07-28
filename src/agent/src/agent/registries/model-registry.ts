import { ORCHESTRATOR_SYSTEM_PROMPT, EXECUTOR_SYSTEM_PROMPT, EVALUATOR_SYSTEM_PROMPT, SUMMARIZER_SYSTEM_PROMPT, REQUEST_ANCHOR_TEMPLATE } from "../context/system-prompt.js";
import { PROJECT_CONTEXT } from '../context/agentcontext.js';
import { ModelsFile, ModelDefinition, RoleDefinition, DEFAULT_TOOL_TIMEOUT_MS } from "./configuration-registry.js";

// prompts addressed by id, so a role's `prompt` field selects one by data — the registry never switches on a role NAME
const PROMPTS: Record<string, string> = {
  project: PROJECT_CONTEXT,
  orchestrator: ORCHESTRATOR_SYSTEM_PROMPT,
  executor: EXECUTOR_SYSTEM_PROMPT,
  evaluator: EVALUATOR_SYSTEM_PROMPT,
  summarizer: SUMMARIZER_SYSTEM_PROMPT,
};

// serves the pure-data role records so swapping a model/prompt/behaviour is a models.json change, never code
export class ModelRegistry {

  private definitions: Record<string, ModelDefinition>;
  private roleDefs: Record<string, RoleDefinition>;

  constructor(private modelsFile: ModelsFile) {
    this.definitions = { ...modelsFile.models };
    this.roleDefs = { ...modelsFile.roles };
    this.assertRolesResolve();
  }

  // gate at construction: every declared role must resolve to a DEFINED model and carry its required fields,
  // so a typo'd or half-declared role fails loudly at boot rather than lazily deep in a turn
  private assertRolesResolve(): void {
    for (const [role, def] of Object.entries(this.roleDefs)) {
      if (!def.model || !this.definitions[def.model]) {
        throw new Error(
          `Role "${role}" is assigned to model "${def.model}", which is not defined in models.json.`
        );
      }
      if (!def.prompt || !def.completion) {
        throw new Error(`Role "${role}" must declare both a "prompt" and a "completion" in models.json.`);
      }
    }
  }

  // the full data record for a role; the runtime reads its fields instead of branching on the role name
  public getRoleDefinition(role: string): RoleDefinition {
    const def = this.roleDefs[role];
    if (!def) {
      throw new Error(`No role "${role}" defined in models.json.`);
    }
    return def;
  }

  public getProviderForRole(role: string): string {
    return this.getRoleDefinition(role).model;
  }

  // resolves a system prompt by id: a role name maps through its `prompt` field, a bare id (e.g. "project") direct
  public getPromptTemplate(roleOrPromptId: string): string {
    const def = this.roleDefs[roleOrPromptId];
    const promptId = def ? def.prompt : roleOrPromptId;
    const prompt = PROMPTS[promptId];
    if (prompt === undefined) {
      throw new Error(`No prompt template for "${promptId}".`);
    }
    return prompt;
  }

  // served through the registry, not the template, so anchor wording can be swapped without touching orchestrator code
  public getAnchorText(request: string): string {
    return REQUEST_ANCHOR_TEMPLATE.replace("{REQUEST}", request);
  }

  public getValidModels(): Array<string>
  {
    const result = new Array<string>();
    for (const def of Object.values(this.roleDefs)) {
      if (this.definitions[def.model]) result.push(def.model);
    }
    return result;
  }

  public getRoles(): Array<string>
  {
    return Object.keys(this.roleDefs);
  }

  public getValidModelForRole(role: string): string {
    return this.getRoleDefinition(role).model;
  }

  // a role's own tool whitelist wins; absent it, the role's model's `mcp` list is the fallback
  public getValidMcpServersForRole(role: string): string[] {
    const def = this.getRoleDefinition(role);
    if (def.tools) return def.tools;
    return this.definitions[def.model]?.mcp ?? [];
  }

  public getTimeoutForModel(name: string): number {
    const model = this.definitions[name];
    return model.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  }

  // undefined when the model defers to the role default
  public getIterationCapForModel(name: string): number | undefined {
    return this.definitions[name]?.iterationCap;
  }

  // repoints an existing role's model (the /model command); other role fields are preserved. A brand-new
  // role gets minimal defaults so the REPL can introduce one without a full record
  public assignRole(role: string, modelId: string): void {
    if (!this.definitions[modelId]) {
      throw new Error(`Model "${modelId}" is not defined in models.json`);
    }
    const existing = this.roleDefs[role] ?? { prompt: role, completion: "self-terminate" };
    this.roleDefs[role] = { ...existing, model: modelId };
  }
}