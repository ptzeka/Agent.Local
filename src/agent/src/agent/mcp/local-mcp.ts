import { CancellationToken } from "../../common/lifetime.js";
import type { ToolDescriptor } from "../providers/provider.js";
import type { Mcp, ToolExecutionResult } from "./mcp.js";

/**
 * One tool owned by a `LocalMcp`: an advertised descriptor (bare,
 * unnamespaced name) plus a direct in-process invocation. The invoke
 * function is expected to catch its own domain errors and shape them into a
 * `ToolExecutionResult`, so each server keeps its historical error wording.
 *
 * `cutoffscope` is the call's CancellationToken: cancelling it — from a parent
 * signal upstream OR the server's own timeout — collapses this call and
 * everything it spawns. Tools that can stop early honour `cutoffscope.signal`;
 * the rest ignore it.
 */
export interface LocalTool {
  readonly descriptor: ToolDescriptor;
  invoke(args: Record<string, unknown>, cutoffscope: CancellationToken): Promise<ToolExecutionResult>;
}

/**
 * An in-process MCP: same shape as a spawned server from the registry's
 * perspective, but tool calls are plain function calls — no SDK `Server`,
 * no transport, no JSON-RPC round-trip.
 */
export class LocalMcp implements Mcp {
  private readonly toolsByName = new Map<string, LocalTool>();
  private timeout?: number;
  constructor(public readonly name: string, tools: LocalTool[]) {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  // Injected once at construction (chainable so the middleware can wire it
  // inline): every call this server runs inherits this per-model tool timeout.
  public setTimeout(t: number): Mcp {
    this.timeout = t;
    return this;
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
    // Derive this call's cutoff from the caller's signal; the injected timeout
    // (if any, > 0) cancels that token so a wedged tool collapses downward.
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
    // Nothing to release: no process, no connection.
  }
}
