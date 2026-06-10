import fs from "node:fs/promises";
import path from "node:path";

import { createProvider, type LLMProvider } from "./providers/index.js";
import type { ToolDescriptor } from "./providers/provider.js";

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

export type RoleName = "orchestrator" | "executor" | "summarizer" | string;

export interface ModelDefinition {
  provider: string;
  model: string;
  supportsTools: boolean;
  reasoning?: boolean;
  description?: string;
  /**
   * Per-model MCP server whitelist, using server names (e.g. "fsmcp", "codemcp").
   * Layers ON TOP of the role split: a model only ever sees tools from servers
   * that are both role-appropriate AND in this list.
   *
   * Omitted key  → no restriction (every role-appropriate tool is advertised).
   * Empty array  → zero tools.
   * Resolved per role via `filterMcpToolsForRole`.
   */
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

interface ModelsFile {
  models: Record<string, ModelDefinition>;
  roles: Record<string, string>;
  orchestration?: Partial<OrchestrationConfig> & LegacyOrchestrationKeys;
}

/**
 * Pre-orchestrator-redesign keys we silently accept so existing models.json
 * files keep working. They no longer drive behaviour.
 */
interface LegacyOrchestrationKeys {
  planFirst?: boolean;
  maxExecutorIterations?: number;
  planTemperature?: number;
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

/**
 * Old role names we still accept in models.json so the rewrite doesn't
 * break existing configs. `coder` and `planner` both alias to `orchestrator`;
 * the executor role must be declared explicitly.
 */
const ROLE_ALIASES: Record<string, RoleName> = {
  coder: "orchestrator",
  planner: "orchestrator",
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
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const geminiApiKey = process.env.GEMINI_API_KEY;
    for (const [id, def] of Object.entries(definitions)) {
      this.providers.set(
        id,
        createProvider({
          provider: def.provider,
          model: def.model,
          supportsTools: def.supportsTools,
          reasoning: def.reasoning,
          host: ollamaHost,
          apiKey: anthropicApiKey,
          geminiApiKey,
        })
      );
    }

    // Normalise role names. Legacy ids (coder, planner) all become
    // "orchestrator" so configs from before the redesign keep loading.
    const normalisedRoles: Record<string, string> = {};
    for (const [rawName, modelId] of Object.entries(roles)) {
      const canonical = ROLE_ALIASES[rawName] ?? rawName;
      normalisedRoles[canonical] = modelId;
    }

    if (forceModelId) {
      // The forced id has to exist in models.json so we know its capabilities.
      if (!this.providers.has(forceModelId)) {
        throw new Error(
          `AGENT_FORCE_MODEL is set to "${forceModelId}" but no model with that id exists in models.json.`
        );
      }
      for (const roleName of Object.keys(normalisedRoles)) {
        this.roleAssignments.set(roleName, forceModelId);
      }
      // When forcing, fill in any missing canonical roles too — every role
      // points at the forced model, so the orchestrator and executor are
      // both addressable even if the user didn't list them.
      for (const required of ["orchestrator", "executor"]) {
        if (!this.roleAssignments.has(required)) {
          this.roleAssignments.set(required, forceModelId);
        }
      }
    } else {
      for (const [roleName, modelId] of Object.entries(normalisedRoles)) {
        if (!this.providers.has(modelId)) {
          throw new Error(
            `Role "${roleName}" points at unknown model "${modelId}". Check models.json.`
          );
        }
        this.roleAssignments.set(roleName, modelId);
      }
      // The orchestrator role is mandatory. The executor falls back to the
      // orchestrator's model if not explicitly assigned (single-model setups).
      if (!this.roleAssignments.has("orchestrator")) {
        throw new Error(
          `models.json must declare a role for "orchestrator" (or legacy "coder"/"planner").`
        );
      }
      if (!this.roleAssignments.has("executor")) {
        this.roleAssignments.set("executor", this.roleAssignments.get("orchestrator")!);
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

    const orchestration = mergeOrchestration(parsed.orchestration);

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

  /**
   * Narrow a role's MCP tool list down to the model's MCP server whitelist.
   *
   * The caller passes the already role-split tools (read-only for the
   * orchestrator, read+mutate for the executor); this applies the per-model
   * `mcp` server whitelist on top, matching on the MCP server prefix
   * (the part before `__` in the tool name). The model→tool mapping lives
   * here in the registry, so role resolution and the whitelist stay in one place.
   *
   * No `mcp` key on the model → returned unchanged (unrestricted). An empty
   * array → no tools. Under AGENT_FORCE_MODEL the role resolves to the forced
   * model, so its whitelist (if any) governs every role.
   */
  public filterMcpToolsForRole(role: RoleName, tools: ToolDescriptor[]): ToolDescriptor[] {
    const modelId = this.roleAssignments.get(role);
    const allowedServers = modelId ? this.definitions[modelId]?.mcp : undefined;
    if (!allowedServers) return tools;
    const allowed = new Set(allowedServers);
    return tools.filter((tool) => {
      // Extract server name from "server__tool_name" format.
      const serverName = tool.name.split("__")[0];
      return allowed.has(serverName);
    });
  }

  /**
   * Provider for the summarizer role. Falls back to the orchestrator's
   * provider when no `summarizer` role is declared in models.json, so
   * legacy configs keep working without a code change.
   */
  public getSummarizerProvider(): LLMProvider {
    const summarizerModelId = this.roleAssignments.get("summarizer");
    if (summarizerModelId) {
      const provider = this.providers.get(summarizerModelId);
      if (provider) return provider;
    }
    return this.getProviderForRole("orchestrator");
  }

  /**
   * Provider for the evaluator (completion-gate) role. Falls back to the
   * orchestrator's provider when no `evaluator` role is declared, so
   * existing configs keep working without a code change.
   */
  public getEvaluatorProvider(): LLMProvider {
    const evaluatorModelId = this.roleAssignments.get("evaluator");
    if (evaluatorModelId) {
      const provider = this.providers.get(evaluatorModelId);
      if (provider) return provider;
    }
    return this.getProviderForRole("orchestrator");
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
   * Legacy role names (coder, planner) alias to "orchestrator" so old REPL
   * shortcuts keep working.
   */
  public assignRole(role: RoleName, modelId: string): void {
    if (!this.providers.has(modelId)) {
      throw new Error(`Cannot assign role "${role}": no model with id "${modelId}" is configured.`);
    }
    const canonical = ROLE_ALIASES[role] ?? role;
    this.roleAssignments.set(canonical, modelId);
  }
}

/**
 * Merge user-provided orchestration config with defaults. Legacy keys
 * (planFirst, planTemperature, maxExecutorIterations) are silently
 * dropped so old models.json files keep loading.
 */
function mergeOrchestration(
  raw: (Partial<OrchestrationConfig> & LegacyOrchestrationKeys) | undefined
): OrchestrationConfig {
  if (!raw) return { ...DEFAULT_ORCHESTRATION };

  // Strip the legacy keys before merging.
  const {
    planFirst: _planFirst,
    maxExecutorIterations: _legacyMax,
    planTemperature: _planTemp,
    ...current
  } = raw;

  return { ...DEFAULT_ORCHESTRATION, ...current };
}
