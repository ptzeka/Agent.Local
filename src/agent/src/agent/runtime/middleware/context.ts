import path from "node:path";

import { buildContextSnapshot, saveContextSnapshot } from "../../context/context-loader.js";
import { fillToolsList } from "../../context/system-prompt.js";
import { buildExecutorRegistry } from "../../registries/executor-registry.js";
import type { ToolDescriptor } from "../../providers/provider.js";
import {
  getExcelToolDescriptors,
  getSubsessionToolDescriptors,
} from "../../synthetic-mcp/index.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface ContextMiddlewareParams {
  /**
   * Role for which to build context ("orchestrator", "executor", etc).
   */
  roleName: string;
  /**
   * Directory for content-addressed context snapshots. Defaults to a `contexts`
   * folder beside the sessions dir (so `…/sessions` and `…/contexts` sit together).
   */
  contextsDir?: string;
  /**
   * Whether the snapshot's tool block includes the sub-session tools. Matches
   * what the orchestrator actually advertises: a top-level run gets them (true,
   * the default); a sub-session runs without a coordinator and never sees them
   * (false), so its snapshot — and therefore its contextHash — is faithfully
   * reduced.
   */
  includeSubSessions?: boolean;
}

/**
 * ContextMiddleware — captures the non-conversation context (system prompt,
 * project direction, tool block) the orchestrator will send, stores it once per
 * unique fingerprint under the contexts dir, and stamps the resulting hash onto
 * the session.
 *
 * This is observability/documentation, not behaviour: it lets you answer "what
 * context did session X run on" without bloating every session file with the
 * large, repeating prefix. The snapshot is content-addressed, so N sessions
 * sharing the same context cost a single file.
 *
 * Requires ctx.session + ctx.workspace (from SessionMiddleware) and ctx.store
 * (from StoreMiddleware); reads ctx.registry/ctx.tools (always seeded). Place it
 * after SessionMiddleware in the pipeline.
 */
export class ContextMiddleware implements IMiddleware {
  constructor(private readonly params: ContextMiddlewareParams) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    if (!ctx.session || !ctx.workspace || !ctx.store) {
      throw new Error(
        "ContextMiddleware: requires ctx.session, ctx.workspace and ctx.store. " +
          "Add StoreMiddleware and SessionMiddleware earlier in the pipeline."
      );
    }

    const role = this.params.roleName;
    const provider = ctx.registry.getProviderForRole(role);

    const shouldIncludeSubSessions = this.params.includeSubSessions !== false;
    let tools: ToolDescriptor[];

    if (role === "executor") {
      // Executor only sees real MCP tools filtered by its whitelist.
      // No synthetic tools (excel, dispatch_executor, subsession).
      tools = ctx.registry.filterMcpByServerWhitelist(
        "executor",
        ctx.mcpRegistry.listTools()
      );
    } else if (ctx.toolDescriptors) {
      // Orchestrator path: OrchestratorMiddleware has already assembled tools.
      // Synthetic tools (excel, subsessions, dispatch_executor) bypass the per-model
      // whitelist — they're always included for orchestration.
      const mcpTools = ctx.toolDescriptors.filter(
        (t) => !t.name.startsWith("excel__") &&
               !t.name.startsWith("subsessions__") &&
               t.name !== "dispatch_executor"
      );
      const filteredMcpTools = ctx.registry.filterMcpByServerWhitelist("orchestrator", mcpTools);
      const excelTools = ctx.toolDescriptors.filter((t) => t.name.startsWith("excel__"));
      const dispatchExecutor = ctx.toolDescriptors.filter((t) => t.name === "dispatch_executor");
      const subsessionTools = shouldIncludeSubSessions
        ? ctx.toolDescriptors.filter((t) => t.name.startsWith("subsessions__"))
        : [];
      tools = [...filteredMcpTools, ...excelTools, ...dispatchExecutor, ...subsessionTools];
    } else {
      // Fallback for orchestrator when OrchestratorMiddleware was skipped (tests).
      const orchestratorTools = ctx.registry.filterMcpByServerWhitelist(
        "orchestrator",
        ctx.mcpRegistry.listToolsForOrchestrator()
      );
      const executorRegistry = buildExecutorRegistry(
        ctx.registry.filterMcpByServerWhitelist("executor", ctx.mcpRegistry.listToolsForExecutor())
      );
      const excelTools = getExcelToolDescriptors();
      const subsessionTools = shouldIncludeSubSessions ? getSubsessionToolDescriptors() : [];
      tools = [
        ...orchestratorTools,
        ...executorRegistry.listDescriptors(),
        ...excelTools,
        ...subsessionTools,
      ];
    }

    const template = ctx.registry.getPromptTemplate(role);
    const systemPrompt = fillToolsList(template, tools);

    const snapshot = buildContextSnapshot({
      model: provider.modelId,
      systemPrompt,
      nativeTools: provider.supportsNativeTools,
      projectContext: ctx.workspace.projectContext,
      tools,
    });

    const contextsDir =
      this.params.contextsDir ?? path.resolve(ctx.sessionsDir, "..", "contexts");
    const hash = await saveContextSnapshot(contextsDir, snapshot);

    // Stamp the pointer by role and persist now so the hash is durable from init, even
    // if the first turn never reaches finalize().
    ctx.session.contextHashes ??= {};
    ctx.session.contextHashes[role] = hash;
    await ctx.store.save(ctx.session);

    await next();
  }

}
