import type { ToolExecutionResult } from "../mcp-client.js";
import type { ToolDescriptor } from "../providers/provider.js";
import { DispatchExecutorTool } from "./dispatch-executor.js";
import { createExcelTools } from "./excel-tools/excel-tools.js";
import { createSubSessionTools } from "./subsessions-tools/subsessions.js";
import { toolError, type SyntheticTool, type SyntheticToolContext } from "./types.js";

/**
 * SyntheticToolRegistry — the orchestrator's single lookup point for synthetic
 * tools. It mirrors the slice of the MCP client the orchestrator uses: list the
 * descriptors to advertise, ask whether a name is handled here, and dispatch a
 * call to a `ToolExecutionResult`. The orchestrator wraps that result into a
 * `role:"tool"` message with the exact same code it uses for real MCP results.
 */
export class SyntheticToolRegistry {
  private readonly byName: Map<string, SyntheticTool>;

  constructor(tools: SyntheticTool[]) {
    this.byName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  /** Descriptors to advertise to the LLM, in registration order. */
  public listDescriptors(): ToolDescriptor[] {
    return [...this.byName.values()].map((tool) => tool.descriptor);
  }

  /** Is this tool name intercepted by the registry (vs. a real MCP tool)? */
  public has(name: string): boolean {
    return this.byName.has(name);
  }

  /**
   * Route a synthetic call to its handler. Returns an error result for an
   * unknown name so a mis-route degrades gracefully instead of throwing.
   */
  public async dispatch(
    name: string,
    args: Record<string, unknown>,
    context: SyntheticToolContext
  ): Promise<ToolExecutionResult> {
    const tool = this.byName.get(name);
    if (!tool) {
      return toolError(`Unknown synthetic tool "${name}".`);
    }
    return tool.callTool(args, context);
  }
}

/**
 * Assemble the synthetic tools for a turn. `dispatch_executor` is always present.
 *
 * Excel and subsession tools are NOT included here; they are exposed through the
 * MCP interface as in-process servers created fresh each turn with that turn's
 * context. The orchestrator conditionally creates these servers when appropriate
 * (subsessions only when a coordinator is wired in).
 */
export function buildSyntheticTools(params: {
  executorTools: ToolDescriptor[];
}): SyntheticToolRegistry {
  const tools: SyntheticTool[] = [new DispatchExecutorTool(params.executorTools)];
  return new SyntheticToolRegistry(tools);
}
