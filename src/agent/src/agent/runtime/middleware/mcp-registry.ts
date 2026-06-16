import path from "node:path";
import { McpClientRegistry } from "../../registries/index.js";
import { createFsLocalMcp, createFsReadonlyLocalMcp, FS_SERVER_NAME, FS_READONLY_SERVER_NAME } from "../../synthetic-mcp/fs-server.js";
import { createExcelLocalMcp, createExcelReadonlyLocalMcp, EXCEL_SERVER_NAME, EXCEL_READONLY_SERVER_NAME } from "../../synthetic-mcp/excel-server.js";
import { createSubsessionsLocalMcp, SUBSESSIONS_SERVER_NAME } from "../../synthetic-mcp/subsessions-server.js";
import { createDelayLocalMcp, DELAY_SERVER_NAME } from "../../synthetic-mcp/delay-server.js";
import { ExecutorLocalMcp, EXECUTOR_SERVER_NAME } from "../../synthetic-mcp/executor-server.js";
import { McpRegistryToken, ModelsToken, SessionToken, WorkspaceToken } from "../tokens.js";
import type { RuntimeContext, IMiddleware } from "../types.js";
import { memoryCollectionFor, type Session } from "../../session/session.js";
import { readMcpServerDefs, mountExternalMcp, type McpServerDef } from "./external-mcp.js";

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
    const executorModelName = modelsRegistry.getValidModelForRole("executor");
    // role mounts inherit the role model's timeout; the executor server carries its own model's
    const serverTimeout = modelsRegistry.getTimeoutForModel(modelName);
    const executorTimeout = modelsRegistry.getTimeoutForModel(executorModelName);

    // these become the orchestrator's visible tools, so a write server landing here would leak into the read-only role
    await this.mountServers(
      mcpRegistry,
      modelsRegistry.getValidMcpServersForRole(this.params.role),
      ctx,
      serverTimeout
    );

    // separate registry so the executor's write tools never reach the orchestrator's scoped client;
    // ExecutorLocalMcp reads it only to enumerate dispatch targets — real execution builds its own registry
    const executorServers = new McpClientRegistry(sandboxRoot);
    await this.mountServers(
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
    const externalDefs = readMcpServerDefs(ctx.mcpConfigPath);

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
    const extraArgs =
      name === MEMOMCP_SERVER_NAME ? ["--collection", memoryCollectionFor(session)] : undefined;
    try {
      const client = await mountExternalMcp(name, def, {
        timeout: serverTimeout,
        signal: ctx.runtimeSignal,
        extraArgs,
      });
      registry.registerClient(client);
      ctx.logger?.debug("mcp external mounted", { name });
    } catch (err) {
      ctx.logger?.warn("mcp external mount failed", { name, error: (err as Error).message });
    }
  }
}
