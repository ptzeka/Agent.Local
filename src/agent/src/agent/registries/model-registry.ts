import { ORCHESTRATOR_SYSTEM_PROMPT, EXECUTOR_SYSTEM_PROMPT, EVALUATOR_SYSTEM_PROMPT, SUMMARIZER_SYSTEM_PROMPT, REQUEST_ANCHOR_TEMPLATE } from "../context/system-prompt.js";
import { PROJECT_CONTEXT } from '../context/agentcontext.js';
import { ModelsFile, ModelDefinition, DEFAULT_TOOL_TIMEOUT_MS } from "./configuration-registry.js";

// maps logical roles onto declared models so swapping a model is a models.json/assignRole change, never code
export class ModelRegistry {

  private definitions: Record<string, ModelDefinition>;
  private roleAssignments: Record<string, string>;

  constructor(private modelsFile: ModelsFile) {
    this.definitions = { ...modelsFile.models };
    this.roleAssignments = { ...modelsFile.roles };
  }

  public getProviderForRole(role: string): string {
    return this.roleAssignments[role];
  }

  public getPromptTemplate(role: string): string {
    switch (role) {
      case "project":
        return PROJECT_CONTEXT;
      case "orchestrator":
      // dispatched-run twin of orchestrator: same prompt, whose guarded "Structured result" section self-activates
      // because this role always has report_result mounted (its model whitelists turnresult)
      case "workflow-orchestrator":
        return ORCHESTRATOR_SYSTEM_PROMPT;
      case "executor":
        return EXECUTOR_SYSTEM_PROMPT;
      case "evaluator":
        return EVALUATOR_SYSTEM_PROMPT;
      case "summarizer":
        return SUMMARIZER_SYSTEM_PROMPT;
      default:
        throw new Error(`No prompt template for role "${role}".`);
    }
  }

  // served through the registry, not the template, so anchor wording can be swapped without touching orchestrator code
  public getAnchorText(request: string): string {
    return REQUEST_ANCHOR_TEMPLATE.replace("{REQUEST}", request);
  }

  public getValidModels(): Array<string>
  {
    var result = new Array<string>();
     for (const [_, modelName] of Object.entries(this.modelsFile.roles)) {
        if (this.definitions[modelName])
          result.push(modelName)
     }
     return result;
  }

  public getRoles(): Array<string>
  {
    var result = new Array<string>();
     for (const [roleName, _] of Object.entries(this.modelsFile.roles)) {
          result.push(roleName)
     }
     return result;
  }
    
  public getValidModelForRole(role: string): string {
    return this.roleAssignments[role];
  }

  public getValidMcpServersForRole(role: string): string[] {
    var modelName = this.roleAssignments[role];
    var model = this.definitions[modelName];
    return model.mcp || [];
  }

  public getTimeoutForModel(name: string): number {
    const model = this.definitions[name];
    return model.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  }

  // undefined when the model defers to the role default
  public getIterationCapForModel(name: string): number | undefined {
    return this.definitions[name]?.iterationCap;
  }

  public assignRole(role: string, modelId: string): void {
    if (!this.definitions[modelId]) {
      throw new Error(`Model "${modelId}" is not defined in models.json`);
    }
    this.roleAssignments[role] = modelId;
  }
}