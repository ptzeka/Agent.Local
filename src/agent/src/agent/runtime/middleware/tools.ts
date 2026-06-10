import { buildExecutorRegistry } from "../../synthetic-mcp/executor-registry.js";
import {
  getExcelToolDescriptors,
  getSubsessionToolDescriptors,
} from "../../synthetic-mcp/index.js";
import type { ToolDescriptor } from "../../providers/provider.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

/**
 * ToolsMiddleware — assembles ALL tool descriptors once per runtime initialization.
 *
 * Reads ctx.registry/ctx.tools (always seeded) and ctx.session/ctx.workspace
 * (from SessionMiddleware) and writes ctx.toolDescriptors before calling next().
 *
 * This is the single source of truth for what tools the orchestrator will see.
 * Each runtime (parent or child) calls this once to assemble its tools, then
 * passes them to the orchestrator via the runtime, not by importing factories.
 *
 * Params:
 * - includeSubSessions: whether to include sub-session tools in the descriptors.
 *   Defaults to true for top-level sessions, false for sub-sessions (one-level-deep guard).
 *   When false, the orchestrator won't advertise create/status/finalize subsession tools.
 */
export interface ToolsMiddlewareParams {
  /**
   * Include sub-session tools in the assembled descriptors.
   * Top-level: true (default); sub-sessions: false (one-level-deep).
   */
  includeSubSessions?: boolean;
}

export class ToolsMiddleware implements IMiddleware {
  constructor(private readonly params: ToolsMiddlewareParams = {}) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    if (!ctx.session || !ctx.workspace) {
      throw new Error(
        "ToolsMiddleware: requires ctx.session and ctx.workspace. " +
          "Add SessionMiddleware earlier in the pipeline."
      );
    }

    const shouldIncludeSubSessions = this.params.includeSubSessions !== false;

    // Real MCP tools (read + executor)
    const orchestratorTools = ctx.registry.filterToolsByServerWhitelist(
      "orchestrator",
      ctx.tools.listToolsForOrchestrator()
    );
    const executorTools = ctx.registry.filterToolsByServerWhitelist(
      "executor",
      ctx.tools.listToolsForExecutor()
    );

    // Synthetic tools
    const executorRegistry = buildExecutorRegistry(executorTools);
    const excelToolDescriptors = ctx.registry.filterToolsByServerWhitelist(
      "orchestrator",
      getExcelToolDescriptors()
    );
    const subsessionToolDescriptors = shouldIncludeSubSessions
      ? ctx.registry.filterToolsByServerWhitelist("orchestrator", getSubsessionToolDescriptors())
      : [];

    // Assemble everything
    const allTools: ToolDescriptor[] = [
      ...orchestratorTools,
      ...executorRegistry.listDescriptors(),
      ...excelToolDescriptors,
      ...subsessionToolDescriptors,
    ];

    ctx.toolDescriptors = allTools;
    await next();
  }
}
