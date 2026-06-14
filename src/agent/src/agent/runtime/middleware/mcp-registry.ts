import path from "node:path";
import { McpClientRegistry } from "../../registries/index.js";
import { createFsLocalMcp, createFsReadonlyLocalMcp, FS_SERVER_NAME, FS_READONLY_SERVER_NAME } from "../../synthetic-mcp/fs-server.js";
import { createExcelLocalMcp, createExcelReadonlyLocalMcp, EXCEL_SERVER_NAME, EXCEL_READONLY_SERVER_NAME } from "../../synthetic-mcp/excel-server.js";
import { createSubsessionsLocalMcp, SUBSESSIONS_SERVER_NAME } from "../../synthetic-mcp/subsessions-server.js";
import { createDelayLocalMcp, DELAY_SERVER_NAME } from "../../synthetic-mcp/delay-server.js";
import { ExecutorLocalMcp, EXECUTOR_SERVER_NAME } from "../../synthetic-mcp/executor-server.js";
import { McpRegistryToken, ModelsToken, SessionToken, WorkspaceToken } from "../tokens.js";
import type { RuntimeContext, IMiddleware } from "../types.js";

// builds the MCP registry and registers the in-process synthetic servers (fsmcp, Excel, subsessions)
// runs after SessionMiddleware so workspace and session are available for the Excel server's tool context
// future stdio servers from mcp.json must receive ctx.runtimeSignal to self-dispose; there is no registry-side teardown
export interface McpRegistryMiddlewareParams {
  // fixes the server whitelist and tool timeout the registry hands to every scoped client
  role: string;
}

export class McpRegistryMiddleware implements IMiddleware {
  constructor(private readonly params: McpRegistryMiddlewareParams) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    // get() throws if the session/workspace/models steps have not run; this step depends on all three
    ctx.registry.get(WorkspaceToken);
    ctx.registry.get(SessionToken);
    const modelsRegistry = ctx.registry.get(ModelsToken);

    ctx.logger?.debug("mcp start", { role: this.params.role });

    const sandboxRoot = ctx.sandboxRoot;
    const mcpRegistry = new McpClientRegistry(sandboxRoot);
    ctx.registry.set(McpRegistryToken, mcpRegistry);

    const modelName = modelsRegistry.getValidModelForRole(this.params.role);
    const executorModelName = modelsRegistry.getValidModelForRole("executor");
    // role mounts inherit the role model's timeout; the executor server carries its own model's
    const serverTimeout = modelsRegistry.getTimeoutForModel(modelName);
    const executorTimeout = modelsRegistry.getTimeoutForModel(executorModelName);

    // these become the orchestrator's visible tools, so a write server landing here would leak into the read-only role
    this.mountServers(
      mcpRegistry,
      modelsRegistry.getValidMcpServersForRole(this.params.role),
      ctx,
      serverTimeout
    );

    // separate registry so the executor's write tools never reach the orchestrator's scoped client;
    // ExecutorLocalMcp reads it only to enumerate dispatch targets — real execution builds its own registry
    const executorServers = new McpClientRegistry(sandboxRoot);
    this.mountServers(
      executorServers,
      modelsRegistry.getValidMcpServersForRole("executor"),
      ctx,
      executorTimeout
    );

    mcpRegistry.registerClient(
      new ExecutorLocalMcp(ctx, executorServers).setTimeout(executorTimeout)
    );

    ctx.logger?.debug("mcp end", { toolCount: mcpRegistry.listTools().length });
    await next();
  }

  // unmatched server names (codemcp, stdio servers) drop out — the declared-but-unmounted semantics the executor relies on
  private mountServers(
    registry: McpClientRegistry,
    serverNames: string[] | undefined,
    ctx: RuntimeContext,
    serverTimeout: number
  ): void {
    const session = ctx.registry.get(SessionToken);
    const workspace = ctx.registry.get(WorkspaceToken);
    const sandboxRoot = ctx.sandboxRoot;
    const fsRoot = path.join(sandboxRoot, session.workspaceId);

    serverNames?.forEach((mcp) => {
      switch (mcp) {
        case FS_SERVER_NAME:
          registry.registerClient(createFsLocalMcp(fsRoot).setTimeout(serverTimeout));
          break;
        case FS_READONLY_SERVER_NAME:
          registry.registerClient(createFsReadonlyLocalMcp(fsRoot).setTimeout(serverTimeout));
          break;
        case EXCEL_READONLY_SERVER_NAME:
          registry.registerClient(createExcelReadonlyLocalMcp({
            session,
            workspace,
            sandboxRoot,
            coordinator: undefined,
            signal: undefined,
          }).setTimeout(serverTimeout));
          break;
        case EXCEL_SERVER_NAME:
          registry.registerClient(createExcelLocalMcp({
            session,
            workspace,
            sandboxRoot,
            coordinator: undefined,
            signal: undefined,
          }).setTimeout(serverTimeout));
          break;
        case SUBSESSIONS_SERVER_NAME:
          registry.registerClient(createSubsessionsLocalMcp({
            session,
            workspace,
            sandboxRoot,
            coordinator: undefined,
            signal: undefined,
          }).setTimeout(serverTimeout));
          break;
        case DELAY_SERVER_NAME:
          registry.registerClient(createDelayLocalMcp(ctx.runtimeSignal).setTimeout(serverTimeout));
          break;
      }
    });
  }
}
