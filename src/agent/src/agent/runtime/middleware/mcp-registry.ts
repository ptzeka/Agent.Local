import { McpClientRegistry } from "../../registries/index.js";
import { createFsLocalMcp } from "../../synthetic-mcp/fs-server.js";
import { createExcelLocalMcp } from "../../synthetic-mcp/excel-server.js";
import type { RuntimeContext, IMiddleware } from "../types.js";

/**
 * Creates the MCP client registry for the session and registers the in-process
 * MCP servers (fsmcp, Excel) on it.
 *
 * Owns the registry's lifecycle: it constructs `McpClientRegistry` bound to the
 * container sandbox root, then registers the synthetic servers. Both are
 * `LocalMcp` instances — plain in-process tool dispatch, no SDK server or
 * transport. They are registered and immediately usable; the (currently
 * stubbed) ConnectMcpServersMiddleware is reserved for spawning real stdio
 * servers declared in mcp.json.
 *
 * Runs after SessionMiddleware so workspace and session are available for the
 * Excel server's tool context.
 */
export class McpRegistryMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    const workspace = ctx.workspace;
    const session = ctx.session;
    if (!workspace || !session) {
      throw new Error("McpRegistryMiddleware: workspace and session must be available in context");
    }

    const sandboxRoot = ctx.sandboxRoot;
    ctx.mcpRegistry = new McpClientRegistry(sandboxRoot);

    // Filesystem/search server — bound to the container sandbox root.
    ctx.mcpRegistry.registerClient(createFsLocalMcp(sandboxRoot));

    // Excel server — bound to this session's tool context. Per-turn fields
    // (coordinator, signal) are absent at session setup, matching prior behavior.
    ctx.mcpRegistry.registerClient(
      createExcelLocalMcp({
        session,
        workspace,
        sandboxRoot,
        coordinator: undefined,
        signal: undefined,
      })
    );

    await next();
  }
}
