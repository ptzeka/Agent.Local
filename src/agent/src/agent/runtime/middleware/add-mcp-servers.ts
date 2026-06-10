import { createFsMcpServer } from "../../synthetic-mcp/fs-server.js";
import { createExcelMcpServer } from "../../synthetic-mcp/excel-server.js";
import type { RuntimeContext, IMiddleware } from "../types.js";

/**
 * Registers in-process MCP servers (fsmcp, Excel) with the registry.
 *
 * Runs after SessionMiddleware so both session and workspace context are available.
 * Servers are registered but not yet connected — that happens in
 * ConnectMcpServersMiddleware.
 */
export class AddMcpServersMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    const workspace = ctx.workspace;
    const session = ctx.session;
    if (!workspace || !session) {
      throw new Error("AddMcpServersMiddleware: workspace and session must be available in context");
    }

    // Register filesystem server
    const fsmcp = await createFsMcpServer(ctx.mcpRegistry.sandboxRoot);
    ctx.mcpRegistry.registerInProcessServer(fsmcp.serverName, fsmcp.client);

    // Register Excel server for this session
    const excelServer = await createExcelMcpServer({
      session,
      workspace,
      sandboxRoot: ctx.mcpRegistry.sandboxRoot,
      coordinator: undefined,
      signal: undefined,
    });
    ctx.mcpRegistry.registerInProcessServer(excelServer.serverName, excelServer.client);

    await next();
  }
}
