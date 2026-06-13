import type { ToolDescriptor } from "../providers/provider.js";
import type { Mcp, ToolExecutionResult } from "./mcp.js";

/**
 * One tool owned by a `LocalMcp`: an advertised descriptor (bare,
 * unnamespaced name) plus a direct in-process invocation. The invoke
 * function is expected to catch its own domain errors and shape them into a
 * `ToolExecutionResult`, so each server keeps its historical error wording.
 */
export interface LocalTool {
  readonly descriptor: ToolDescriptor;
  invoke(args: Record<string, unknown>): Promise<ToolExecutionResult>;
}

/**
 * An in-process MCP: same shape as a spawned server from the registry's
 * perspective, but tool calls are plain function calls — no SDK `Server`,
 * no transport, no JSON-RPC round-trip.
 */
export class LocalMcp implements Mcp {
  private readonly toolsByName = new Map<string, LocalTool>();

  constructor(public readonly name: string, tools: LocalTool[]) {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  // Subclasses whose handlers close over `this` cannot pass tools to super();
  // they call this after super(), one tool per call.
  protected registerTool(tool: LocalTool): void {
    this.toolsByName.set(tool.descriptor.name, tool);
  }

  public listTools(): ToolDescriptor[] {
    return [...this.toolsByName.values()].map((tool) => ({
      name: `${this.name}__${tool.descriptor.name}`,
      description: tool.descriptor.description,
      inputSchema: tool.descriptor.inputSchema,
    }));
  }

  public async callTool(toolName: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const tool = this.toolsByName.get(toolName);
    if (!tool) {
      return {
        isError: true,
        content: `Unknown tool "${toolName}" on server "${this.name}".`,
      };
    }

    try {
      return await tool.invoke(args);
    } catch (err) {
      // Safety net only — tool adapters shape their own errors above this.
      return {
        isError: true,
        content: `Tool "${toolName}" threw: ${(err as Error).message}`,
      };
    }
  }

  public async shutdown(): Promise<void> {
    // Nothing to release: no process, no connection.
  }
}
