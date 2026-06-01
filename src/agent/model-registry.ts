import fs from "node:fs/promises";
import path from "node:path";

import { createProvider, type LLMProvider } from "./providers/index.js";

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

export type RoleName = "planner" | "coder" | "summarizer" | string;

export interface ModelDefinition {
  provider: string;
  model: string;
  supportsTools: boolean;
  reasoning?: boolean;
  description?: string;
}

export interface OrchestrationConfig {
  planFirst: boolean;
  maxExecutorIterations: number;
  planTemperature: number;
  executorTemperature: number;
}

interface ModelsFile {
  models: Record<string, ModelDefinition>;
  roles: Record<string, string>;
  orchestration?: Partial<OrchestrationConfig>;
}

const DEFAULT_ORCHESTRATION: OrchestrationConfig = {
  planFirst: true,
  maxExecutorIterations: 12,
  planTemperature: 0.2,
  executorTemperature: 0.1,
};

export class ModelRegistry {
  private readonly providers = new Map<string, LLMProvider>();
  private readonly roleAssignments = new Map<RoleName, string>();
  private readonly definitions: Record<string, ModelDefinition>;
  public readonly orchestration: OrchestrationConfig;

  private constructor(
    definitions: Record<string, ModelDefinition>,
    roles: Record<string, string>,
    orchestration: OrchestrationConfig,
    ollamaHost: string,
    forceModelId: string | undefined
  ) {
    this.definitions = definitions;
    this.orchestration = orchestration;

    // Build one provider per declared model. If AGENT_FORCE_MODEL is set,
    // we still build every provider — but the role table gets remapped so
    // the forced model handles every role.
    for (const [id, def] of Object.entries(definitions)) {
      this.providers.set(
        id,
        createProvider({
          provider: def.provider,
          model: def.model,
          supportsTools: def.supportsTools,
          reasoning: def.reasoning,
          host: ollamaHost,
        })
      );
    }

    if (forceModelId) {
      // The forced id has to exist in models.json so we know its capabilities.
      if (!this.providers.has(forceModelId)) {
        throw new Error(
          `AGENT_FORCE_MODEL is set to "${forceModelId}" but no model with that id exists in models.json.`
        );
      }
      for (const roleName of Object.keys(roles)) {
        this.roleAssignments.set(roleName, forceModelId);
      }
    } else {
      for (const [roleName, modelId] of Object.entries(roles)) {
        if (!this.providers.has(modelId)) {
          throw new Error(
            `Role "${roleName}" points at unknown model "${modelId}". Check models.json.`
          );
        }
        this.roleAssignments.set(roleName, modelId);
      }
    }
  }

  public static async load(configPath: string): Promise<ModelRegistry> {
    const absolutePath = path.resolve(configPath);
    const raw = await fs.readFile(absolutePath, "utf8");
    const parsed = JSON.parse(raw) as ModelsFile;

    if (!parsed.models || Object.keys(parsed.models).length === 0) {
      throw new Error(`${absolutePath} declares no models.`);
    }
    if (!parsed.roles || Object.keys(parsed.roles).length === 0) {
      throw new Error(`${absolutePath} declares no role assignments.`);
    }

    const ollamaHost = process.env.OLLAMA_HOST ?? "http://localhost:11434";
    const forceModelId = process.env.AGENT_FORCE_MODEL;

    const orchestration: OrchestrationConfig = {
      ...DEFAULT_ORCHESTRATION,
      ...(parsed.orchestration ?? {}),
    };

    return new ModelRegistry(parsed.models, parsed.roles, orchestration, ollamaHost, forceModelId);
  }

  public getProviderForRole(role: RoleName): LLMProvider {
    const modelId = this.roleAssignments.get(role);
    if (!modelId) {
      throw new Error(`No model assigned for role "${role}".`);
    }
    const provider = this.providers.get(modelId);
    if (!provider) {
      // Should be unreachable because the constructor validates.
      throw new Error(`Internal error: role "${role}" maps to missing model "${modelId}".`);
    }
    return provider;
  }

  public listRoles(): Array<{ role: RoleName; modelId: string; provider: LLMProvider }> {
    return [...this.roleAssignments.entries()].map(([role, modelId]) => ({
      role,
      modelId,
      provider: this.providers.get(modelId)!,
    }));
  }

  public listModels(): Array<{ id: string; definition: ModelDefinition }> {
    return Object.entries(this.definitions).map(([id, definition]) => ({ id, definition }));
  }

  /**
   * Hot-swap a role assignment at runtime. Triggered from REPL slash commands.
   */
  public assignRole(role: RoleName, modelId: string): void {
    if (!this.providers.has(modelId)) {
      throw new Error(`Cannot assign role "${role}": no model with id "${modelId}" is configured.`);
    }
    this.roleAssignments.set(role, modelId);
  }
}
