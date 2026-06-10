import type { RuntimeContext, IMiddleware } from "../types.js";

/**
 * Connects all registered MCP servers (both in-process and stdio from mcp.json).
 *
 * Runs after AddMcpServersMiddleware so all servers are registered.
 * Once connected, all tools are available to the orchestrator.
 */
export class ConnectMcpServersMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    await ctx.mcpRegistry.connectAll(ctx.mcpConfigPath);
    await next();
  }
}
