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

    // Get all available tools
    const orchestratorTools = ctx.tools.listToolsForOrchestrator();
    const executorTools = ctx.tools.listToolsForExecutor();

    // Build executor registry for routing dispatch_executor calls
    const executorRegistry = buildExecutorRegistry(executorTools);

    // Get synthetic tool descriptors
    const excelToolDescriptors = getExcelToolDescriptors();
    const subsessionToolDescriptors = shouldIncludeSubSessions ? getSubsessionToolDescriptors() : [];

    // Assemble all tools (filtering by model/role happens in Orchestrator)
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
