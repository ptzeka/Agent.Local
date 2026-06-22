import path from "node:path";
import { McpClientRegistry } from "../../registries/index.js";
import type { ModelRegistry } from "../../registries/index.js";
import { createFsLocalMcp, createFsReadonlyLocalMcp, FS_SERVER_NAME, FS_READONLY_SERVER_NAME } from "../../synthetic-mcp/fs-server.js";
import { createExcelLocalMcp, createExcelReadonlyLocalMcp, EXCEL_SERVER_NAME, EXCEL_READONLY_SERVER_NAME } from "../../synthetic-mcp/excel-server.js";
import { createSubsessionsLocalMcp, SUBSESSIONS_SERVER_NAME } from "../../synthetic-mcp/subsessions-server.js";
import { createDelayLocalMcp, DELAY_SERVER_NAME } from "../../synthetic-mcp/delay-server.js";
import { ExecutorLocalMcp, EXECUTOR_SERVER_NAME, EXECUTOR_ROLE } from "../../synthetic-mcp/executor-server.js";
import { ConfigurationToken, McpRegistryToken, ModelsToken, SessionToken, WorkspaceToken } from "../tokens.js";
import type { RuntimeContext, IMiddleware } from "../types.js";
import { memoryCollectionFor, type Session } from "../../session/session.js";
import { mountExternalMcp, type McpServerDef } from "./external-mcp.js";

// memomcp is segregated per session: each spawned instance reads/writes only this session's collection
const MEMOMCP_SERVER_NAME = "memomcp";

// builds the MCP registry and registers the in-process synthetic servers (fsmcp, Excel, subsessions)
// runs after SessionMiddleware so workspace and session are available for the Excel server's tool context
// stdio servers declared in mcp.json (codemcp, memomcp) are spawned here and receive ctx.runtimeSignal
// to self-dispose; there is no registry-side teardown
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
    const serverTimeout = modelsRegistry.getTimeoutForModel(modelName);
    const validMcpClients = modelsRegistry.getValidMcpServersForRole(this.params.role);
    await this.mountServers(
      mcpRegistry,
      validMcpClients,
      ctx,
      serverTimeout
    );

    await this.mountExecutorSeam(mcpRegistry, modelsRegistry, ctx);

    ctx.logger?.debug("mcp end", { toolCount: mcpRegistry.listTools().length });
    await next();
  }

  // executor__dispatch is the orchestrator's ONLY path to mutation, so the seam is mounted for every
  // non-executor role regardless of whitelist — it can't be removed by config, and a child executor
  // never gets one (no grandchildren). The executor's write tools live in a SEPARATE registry,
  // enumerable only through the dispatch descriptor's enum, never reachable via the scoped client.
  private async mountExecutorSeam(
    registry: McpClientRegistry,
    modelsRegistry: ModelRegistry,
    ctx: RuntimeContext
  ): Promise<void> {
    if (this.params.role === EXECUTOR_ROLE) return;
    const executorServers = new McpClientRegistry(ctx.sandboxRoot);
    const executorModel = modelsRegistry.getValidModelForRole(EXECUTOR_ROLE);
    const executorTimeout = modelsRegistry.getTimeoutForModel(executorModel);
    const executorWhitelist = modelsRegistry.getValidMcpServersForRole(EXECUTOR_ROLE);
    await this.mountServers(executorServers, executorWhitelist, ctx, executorTimeout);
    registry.registerClient(new ExecutorLocalMcp(ctx, executorServers));
  }

  // synthetic servers are matched by name; any other name is looked up in mcp.json and spawned as a
  // stdio server (codemcp, memomcp). A name in neither place drops out — the declared-but-unmounted
  // semantics the executor relies on.
  private async mountServers(
    registry: McpClientRegistry,
    serverNames: string[] | undefined,
    ctx: RuntimeContext,
    serverTimeout: number
  ): Promise<void> {
    const session = ctx.registry.get(SessionToken);
    const workspace = ctx.registry.get(WorkspaceToken);
    const sandboxRoot = ctx.sandboxRoot;
    const fsRoot = path.join(sandboxRoot, session.workspaceId);
    const externalDefs = ctx.registry.get(ConfigurationToken).getMcpServerDefs();
    
    for (const mcp of serverNames ?? []) {
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
        case EXECUTOR_SERVER_NAME:
          // the seam is mounted once in mountExecutorSeam(); a whitelist entry here is declarative, so swallow it
          break;
        default:
          await this.mountExternal(registry, mcp, externalDefs, ctx, serverTimeout, session);
      }
    }
  }

  // spawns a stdio server from its mcp.json definition; a failed spawn is logged and skipped so one
  // unavailable server never breaks the runtime. memomcp gets this session's collection injected so
  // its memory is segregated (see memoryCollectionFor).
  private async mountExternal(
    registry: McpClientRegistry,
    name: string,
    defs: Record<string, McpServerDef>,
    ctx: RuntimeContext,
    serverTimeout: number,
    session: Session
  ): Promise<void> {
    const def = defs[name];
    if (!def) {
      ctx.logger?.debug("mcp external skip — not in mcp.json", { name });
      return;
    }
    try {
      switch (name) {
        case MEMOMCP_SERVER_NAME:
          if (session.memoryCollectionId)
          {
            const client = await mountExternalMcp(name, def, {
              timeout: serverTimeout,
              signal: ctx.runtimeSignal,
              extraArgs: ["--collection", session.memoryCollectionId],
              logger: ctx.logger,
            });
            registry.registerClient(client);
            ctx.logger?.debug("mcp external mounted", { name });
          }
        break;
    }
    } catch (err) {
      ctx.logger?.warn("mcp external mount failed", { name, error: (err as Error).message });
    }
  }
}
