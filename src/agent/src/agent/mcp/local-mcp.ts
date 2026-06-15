import { CancellationToken } from "@agent-local/common/lifetime";
import type { ToolDescriptor } from "../providers/provider.js";
import type { Mcp, ToolExecutionResult } from "./mcp.js";

// invoke owns its domain errors and shapes them into a ToolExecutionResult so each server keeps its wording
// cutoffscope cancels from a parent signal OR the server timeout, collapsing this call and all it spawns
export interface LocalTool {
  readonly descriptor: ToolDescriptor;
  invoke(args: Record<string, unknown>, cutoffscope: CancellationToken): Promise<ToolExecutionResult>;
}

// in-process MCP: looks like a spawned server to the registry, but calls are plain
// function calls — no SDK Server, transport, or JSON-RPC round-trip
export class LocalMcp implements Mcp {
  private readonly toolsByName = new Map<string, LocalTool>();
  private timeout?: number;
  constructor(public readonly name: string, tools: LocalTool[]) {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  // chainable so middleware can wire it inline; sets the per-model timeout every call inherits
  public setTimeout(t: number): Mcp {
    this.timeout = t;
    return this;
  }

  // subclasses whose handlers close over `this` can't pass tools to super(); they register post-super
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

  public async callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ToolExecutionResult> {
    const tool = this.toolsByName.get(toolName);
    if (!tool) {
      return {
        isError: true,
        content: `Unknown tool "${toolName}" on server "${this.name}".`,
      };
    }
    // timeout cancels this token so a wedged tool collapses downward instead of hanging the caller
    const cutoff = new CancellationToken(signal);
    let timer: NodeJS.Timeout | null = null;
    try {
      if (this.timeout && this.timeout > 0) {
        timer = setTimeout(() => {
          if (!cutoff.cancelled) {
            cutoff.cancel(`Tool "${this.name}__${toolName}" timed out after ${this.timeout}ms.`);
          }
        }, this.timeout);
      }
      return await tool.invoke(args, cutoff);
    } catch (err) {
      return {
        isError: true,
        content: `Tool "${toolName}" threw: ${(err as Error).message}`,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }


  public async shutdown(): Promise<void> {
    // nothing to release: no process, no connection
  }
}
