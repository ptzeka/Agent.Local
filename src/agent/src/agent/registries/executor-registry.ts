import type { ToolExecutionResult } from "../mcp/mcp-client.js";
import type { ToolDescriptor } from "../providers/provider.js";
import { DispatchExecutorTool } from "../synthetic-mcp/dispatch-executor.js";
import { toolError, type SyntheticMcpContext } from "../synthetic-mcp/types.js";

/**
 * ExecutorRegistry — intercepts the `dispatch_executor` tool call.
 *
 * The orchestrator LLM can only mutate the workspace via `dispatch_executor`,
 * which routes to the Executor sub-agent. This registry is the single
 * lookup point: check if a tool call is `dispatch_executor`, route it to
 * the handler, and return a ToolExecutionResult wrapped into a role:"tool"
 * message (identical code path as real MCP results).
 */
export class ExecutorRegistry {
  private readonly tool: DispatchExecutorTool;

  constructor(executorTools: ToolDescriptor[]) {
    this.tool = new DispatchExecutorTool(executorTools);
  }

  /** Descriptor to advertise to the LLM. */
  public listDescriptors(): ToolDescriptor[] {
    return [this.tool.descriptor];
  }

  /** Is this the dispatch_executor tool? */
  public has(name: string): boolean {
    return name === this.tool.name;
  }

  /** Dispatch to the executor. */
  public async dispatch(
    name: string,
    args: Record<string, unknown>,
    context: SyntheticMcpContext
  ): Promise<ToolExecutionResult> {
    if (!this.has(name)) {
      return toolError(`Unknown executor tool "${name}".`);
    }
    return this.tool.callTool(args, context);
  }
}