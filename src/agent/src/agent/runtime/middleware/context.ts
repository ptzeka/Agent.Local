import path from "node:path";

import { buildContextSnapshot, saveContextSnapshot } from "../../context-loader.js";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "../../system-prompt.js";
import { buildExecutorRegistry } from "../../registries/executor-registry.js";
import {
  getExcelToolDescriptors,
  getSubsessionToolDescriptors,
} from "../../synthetic-mcp/index.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface ContextMiddlewareParams {
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
  constructor(private readonly params: ContextMiddlewareParams = {}) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    if (!ctx.session || !ctx.workspace || !ctx.store) {
      throw new Error(
        "ContextMiddleware: requires ctx.session, ctx.workspace and ctx.store. " +
          "Add StoreMiddleware and SessionMiddleware earlier in the pipeline."
      );
    }

    const orchestrator = ctx.registry.getProviderForRole("orchestrator");

    // Build tool list with proper filtering.
    // Synthetic tools (excel, subsessions, dispatch_executor) are NOT subject to
    // per-model whitelists — they're always included for orchestration.
    const shouldIncludeSubSessions = this.params.includeSubSessions !== false;
    let tools: typeof ctx.toolDescriptors;

    if (ctx.toolDescriptors) {
      // OrchestratorMiddleware has already assembled tools. Extract and re-assemble with
      // proper filtering: MCP tools go through the whitelist, synthetic tools don't.
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
      // Fallback: rebuild from MCP client registry (used in tests that skip OrchestratorMiddleware).
      const executorTools = ctx.registry.filterMcpByServerWhitelist(
        "executor",
        ctx.mcpRegistry.listToolsForExecutor()
      );
      const orchestratorTools = ctx.registry.filterMcpByServerWhitelist(
        "orchestrator",
        ctx.mcpRegistry.listToolsForOrchestrator()
      );
      const executorRegistry = buildExecutorRegistry(executorTools);
      const excelTools = getExcelToolDescriptors();
      const subsessionTools = shouldIncludeSubSessions ? getSubsessionToolDescriptors() : [];
      tools = [
        ...orchestratorTools,
        ...executorRegistry.listDescriptors(),
        ...excelTools,
        ...subsessionTools,
      ];
    }

    const snapshot = buildContextSnapshot({
      model: orchestrator.modelId,
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
      nativeTools: orchestrator.supportsNativeTools,
      projectContext: ctx.workspace.projectContext,
      tools,
    });

    const contextsDir =
      this.params.contextsDir ?? path.resolve(ctx.sessionsDir, "..", "contexts");
    const hash = await saveContextSnapshot(contextsDir, snapshot);

    // Stamp the pointer and persist now so the hash is durable from init, even
    // if the first turn never reaches finalize().
    ctx.session.contextHash = hash;
    await ctx.store.save(ctx.session);

    await next();
  }
}
