import path from "node:path";
import { McpClientRegistry } from "../../registries/index.js";
import { createFsLocalMcp, createFsReadonlyLocalMcp, FS_SERVER_NAME } from "../../synthetic-mcp/fs-server.js";
import { createExcelLocalMcp, createExcelReadonlyLocalMcp, EXCEL_SERVER_NAME, EXCEL_READONLY_SERVER_NAME } from "../../synthetic-mcp/excel-server.js";
import { createSubsessionsLocalMcp, SUBSESSIONS_SERVER_NAME } from "../../synthetic-mcp/subsessions-server.js";
import { createDelayLocalMcp, DELAY_SERVER_NAME } from "../../synthetic-mcp/delay-server.js";
import { ExecutorLocalMcp, EXECUTOR_SERVER_NAME } from "../../synthetic-mcp/executor-server.js";
import type { RuntimeContext, IMiddleware } from "../types.js";

/**
 * Creates the MCP client registry for the session and registers the in-process
 * MCP servers (fsmcp, Excel, subsessions) on it.
 *
 * Owns the registry's lifecycle: it constructs `McpClientRegistry` bound to the
 * container sandbox root, then registers the synthetic servers. Both are
 * `LocalMcp` instances — plain in-process tool dispatch, no SDK server or
 * transport. They are registered and immediately usable. Spawning real stdio
 * servers declared in mcp.json is not implemented yet; when it lands, each
 * spawned client must receive ctx.runtimeSignal so it self-disposes — there
 * is no registry-side teardown by design.
 *
 * Runs after SessionMiddleware so workspace and session are available for the
 * Excel server's tool context.
 */

export interface McpRegistryMiddlewareParams {
  /** Static role of the owning runtime — fixes the server whitelist and tool
   *  timeout the registry hands to every scoped client it builds. */
  role: string;
}

export class McpRegistryMiddleware implements IMiddleware {
  constructor(private readonly params: McpRegistryMiddlewareParams) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    const workspace = ctx.workspace;
    const session = ctx.session;
    if (!workspace || !session) {
      throw new Error("McpRegistryMiddleware: workspace and session must be available in context");
    }
    const modelsRegistry = ctx.modelsRegistry;
    if (!modelsRegistry) {
      throw new Error("McpRegistryMiddleware: modelsRegistry must be available in context");
    }

    const sandboxRoot = ctx.sandboxRoot;
    ctx.mcpRegistry = new McpClientRegistry(sandboxRoot);

    const modelName = modelsRegistry.getValidModelForRole(this.params.role);
    const executorModelName = modelsRegistry.getValidModelForRole("executor");
    const mcps = modelsRegistry.getValidMcpServersForRole(this.params.role);
    // Every server this role mounts inherits the role model's tool timeout; the
    // executor server is the one exception — it carries its own model's.
    const serverTimeout = modelsRegistry.getTimeoutForModel(modelName);
    const executorTimeout = modelsRegistry.getTimeoutForModel(executorModelName);
    
    mcps?.forEach((mcp, _) => {
      switch(mcp)
      {
        case FS_SERVER_NAME: 
          const fsRoot = path.join(sandboxRoot, session.workspaceId);
          ctx.mcpRegistry!.registerClient(createFsLocalMcp(fsRoot).setTimeout(serverTimeout));
          ctx.mcpRegistry!.registerClient(createFsReadonlyLocalMcp(fsRoot).setTimeout(serverTimeout));
        break;
        case EXCEL_READONLY_SERVER_NAME:
          ctx.mcpRegistry!.registerClient(createExcelReadonlyLocalMcp({
            session,
            workspace,
            sandboxRoot,
            coordinator: undefined,
            signal: undefined
          }).setTimeout(serverTimeout));
        break;
        case EXCEL_SERVER_NAME:          
          ctx.mcpRegistry!.registerClient(createExcelLocalMcp({
              session,
              workspace,
              sandboxRoot,
              coordinator: undefined,
              signal: undefined
            }).setTimeout(serverTimeout));      
        break;
        case SUBSESSIONS_SERVER_NAME:
        ctx.mcpRegistry!.registerClient(
          createSubsessionsLocalMcp({
            session,
            workspace,
            sandboxRoot,
            coordinator: undefined,
            signal: undefined,
          }).setTimeout(serverTimeout)
        );
        break;
        case DELAY_SERVER_NAME:
            ctx.mcpRegistry!.registerClient(createDelayLocalMcp(ctx.runtimeSignal).setTimeout(serverTimeout));
        break;
      }
    });
    ctx.mcpRegistry.registerClient(new ExecutorLocalMcp(ctx).setTimeout(executorTimeout));
    await next();
  }
}
