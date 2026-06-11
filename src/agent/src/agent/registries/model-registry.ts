import { ORCHESTRATOR_SYSTEM_PROMPT, EXECUTOR_SYSTEM_PROMPT } from "../context/system-prompt.js";
import { PROJECT_CONTEXT } from '../context/agentcontext.js';
import { ModelsFile, ModelDefinition } from "./configuration-registry.js";
/**
 * Model registry.
 *
 * Loads models.json, instantiates one provider per declared model, and
 * maps logical roles ("planner", "coder", "summarizer") onto those providers.
 *
 * The orchestrator only ever asks: "give me the provider for role X".
 * Swapping models therefore means editing models.json or calling
 * `assignRole`, never touching agent code.
 */

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
        return ORCHESTRATOR_SYSTEM_PROMPT;
      case "executor":
        return EXECUTOR_SYSTEM_PROMPT;
      default:
        throw new Error(`No prompt template for role "${role}".`);
    }
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
    
  public getValidMcpForModel(role: string): string[] {
    var modelName = this.roleAssignments[role];
    var model = this.definitions[modelName];
    return model.mcp || [];
  }

  public assignRole(role: string, modelId: string): void {
    if (!this.definitions[modelId]) {
      throw new Error(`Model "${modelId}" is not defined in models.json`);
    }
    this.roleAssignments[role] = modelId;
  }
}