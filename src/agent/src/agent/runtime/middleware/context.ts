import path from "node:path";

import { buildContextSnapshot, saveContextSnapshot } from "../../context-loader.js";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "../../system-prompt.js";
import { buildExecutorRegistry } from "../../synthetic-mcp/executor-registry.js";
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

    // Mirror exactly what the orchestrator advertises each turn — its read tools
    // plus the synthetic tools (dispatch_executor, excel, sub-sessions) — so the
    // snapshot faithfully records the tool block the model receives.
    // Apply the same role split + per-model whitelist the orchestrator uses at
    // runtime, so the snapshot's tool block faithfully mirrors what each model
    // is actually advertised.
    const executorTools = ctx.registry.filterToolsByServerWhitelist(
      "executor",
      ctx.tools.listToolsForExecutor()
    );
    const orchestratorTools = ctx.registry.filterToolsByServerWhitelist(
      "orchestrator",
      ctx.tools.listToolsForOrchestrator()
    );
    const executorRegistry = buildExecutorRegistry(executorTools);
    const tools = [...orchestratorTools, ...executorRegistry.listDescriptors()];

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
