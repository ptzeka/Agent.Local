import path from "node:path";
import { McpClientRegistry } from "../../registries/index.js";
import type { ModelRegistry } from "../../registries/index.js";
import { createFsLocalMcp, createFsReadonlyLocalMcp, FS_SERVER_NAME, FS_READONLY_SERVER_NAME } from "../../synthetic-mcp/fs-server.js";
import { createExcelLocalMcp, createExcelReadonlyLocalMcp, EXCEL_SERVER_NAME, EXCEL_READONLY_SERVER_NAME } from "../../synthetic-mcp/excel-server.js";
import { createSubsessionsLocalMcp, SUBSESSIONS_SERVER_NAME } from "../../synthetic-mcp/subsessions-server.js";
import { TurnResultLocalMcp, TURN_RESULT_SERVER_NAME } from "../../synthetic-mcp/turn-result-server.js";
import { createDelayLocalMcp, DELAY_SERVER_NAME } from "../../synthetic-mcp/delay-server.js";
import { ExecutorLocalMcp, EXECUTOR_SERVER_NAME, EXECUTOR_ROLE } from "../../synthetic-mcp/executor-server.js";
import { RoleDispatchLocalMcp, DISPATCH_TOOL } from "../../synthetic-mcp/role-dispatch-server.js";
import { EVALUATOR_ROLE, EVALUATOR_SERVER_NAME, EVALUATE_TOOL } from "../../runners/evaluator-pass.js";
import type { SubSessionCoordinator } from "../../runners/subsession.js";
import { ConfigurationToken, McpRegistryToken, ModelsToken, SessionManagerToken, SessionToken, WorkspaceToken } from "../tokens.js";
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
      serverTimeout,
      // runs after SessionManagerMiddleware so subsession tools route to the live coordinator
      ctx.registry.get(SessionManagerToken),
      // a coordinator may mount role-agents; a dispatchable role is a leaf and must not (the recursion guard)
      modelsRegistry.getRoleDefinition(this.params.role).dispatchable ? undefined : modelsRegistry
    );

    await this.mountExecutorSeam(mcpRegistry, modelsRegistry, ctx, validMcpClients);
    this.mountEvaluatorSeam(mcpRegistry, modelsRegistry, ctx);

    ctx.logger?.debug("mcp end", { toolCount: mcpRegistry.listTools().length });
    await next();
  }

  // executor__dispatch is a tool GRANT: a role gets the seam only when it whitelists the executor server. So a
  // coordinator (orchestrator) that lists it can mutate via dispatch, while a leaf sub-agent — the executor
  // itself, or a read-only role like the evaluator — never does. The executor's write tools live in a SEPARATE
  // registry, enumerable only through the dispatch descriptor's enum, never reachable via the scoped client.
  private async mountExecutorSeam(
    registry: McpClientRegistry,
    modelsRegistry: ModelRegistry,
    ctx: RuntimeContext,
    whitelist: string[]
  ): Promise<void> {
    if (!whitelist.includes(EXECUTOR_SERVER_NAME)) return;
    const executorServers = new McpClientRegistry(ctx.sandboxRoot);
    const executorModel = modelsRegistry.getValidModelForRole(EXECUTOR_ROLE);
    const executorTimeout = modelsRegistry.getTimeoutForModel(executorModel);
    const executorWhitelist = modelsRegistry.getValidMcpServersForRole(EXECUTOR_ROLE);
    // neither coordinator nor role-agents: an executor is a leaf, so its seam keeps the "not available" error
    await this.mountServers(executorServers, executorWhitelist, ctx, executorTimeout, undefined, undefined);
    registry.registerClient(new ExecutorLocalMcp(ctx, executorServers));
  }

  // the terminal judge is a dispatch tool the loop's epilogue calls; it is NOT in any role's whitelist, so it
  // never reaches a model's visible surface — mounted only for coordinator (non-dispatchable) roles, so a leaf
  // sub-agent (the executor, or the evaluator's own child run) never carries it and can't recursively self-judge
  private mountEvaluatorSeam(registry: McpClientRegistry, modelsRegistry: ModelRegistry, ctx: RuntimeContext): void {
    if (modelsRegistry.getRoleDefinition(this.params.role).dispatchable) return;
    if (!modelsRegistry.getRoles().includes(EVALUATOR_ROLE)) return;
    const dispatch = modelsRegistry.getRoleDefinition(EVALUATOR_ROLE).dispatch;
    if (!dispatch) return;
    const timeout = modelsRegistry.getTimeoutForModel(modelsRegistry.getValidModelForRole(EVALUATOR_ROLE));
    registry.registerClient(
      new RoleDispatchLocalMcp(ctx, EVALUATOR_ROLE, dispatch, EVALUATOR_SERVER_NAME, EVALUATE_TOOL).setTimeout(timeout)
    );
  }

  // synthetic servers are matched by name; any other name is either a dispatchable ROLE (mounted as a
  // sub-agent tool) or looked up in mcp.json and spawned as a stdio server (codemcp, memomcp). A name in
  // none of the three drops out — the declared-but-unmounted semantics the executor relies on.
  private async mountServers(
    registry: McpClientRegistry,
    serverNames: string[] | undefined,
    ctx: RuntimeContext,
    serverTimeout: number,
    coordinator: SubSessionCoordinator | undefined,
    // present ⇒ a whitelisted name may resolve to a role-agent; undefined on a leaf, which mounts none
    dispatchRoles: ModelRegistry | undefined
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
          }).setTimeout(serverTimeout));
          break;
        case EXCEL_SERVER_NAME:
          registry.registerClient(createExcelLocalMcp({
            session,
            workspace,
            sandboxRoot,
          }).setTimeout(serverTimeout));
          break;
        case SUBSESSIONS_SERVER_NAME:
          registry.registerClient(createSubsessionsLocalMcp({
            session,
            workspace,
            sandboxRoot,
            coordinator,
          }).setTimeout(serverTimeout));
          break;
        case TURN_RESULT_SERVER_NAME:
          // whitelisting it IS the opt-in: only the workflow-orchestrator role lists turnresult, so interactive
          // roles never mount it. its presence is what the runner reads to enter structured mode; the live sink
          // arrives via the runner's per-turn bindTurn pass.
          registry.registerClient(new TurnResultLocalMcp({
            session,
            workspace,
            sandboxRoot,
          }).setTimeout(serverTimeout));
          break;
        case DELAY_SERVER_NAME:
          registry.registerClient(createDelayLocalMcp(ctx.runtimeSignal).setTimeout(serverTimeout));
          break;
        case EXECUTOR_SERVER_NAME:
          // the seam is mounted once in mountExecutorSeam(); a whitelist entry here is declarative, so swallow it
          break;
        default:
          // the whitelist entry IS the role name, so adding a sub-agent is a models.json record, never code here
          if (!this.mountRoleAgent(registry, dispatchRoles, mcp, ctx)) {
            await this.mountExternal(registry, mcp, externalDefs, ctx, serverTimeout, session);
          }
      }
    }
  }

  // mounts a whitelisted name that resolves to a dispatchable role as `<role>__ask`: one call runs that role
  // as a fresh child and gates its answer on the role's `returns`. Returns false when the name is not a
  // role-agent, so the caller falls through to the mcp.json lookup.
  private mountRoleAgent(
    registry: McpClientRegistry,
    dispatchRoles: ModelRegistry | undefined,
    name: string,
    ctx: RuntimeContext
  ): boolean {
    if (!dispatchRoles || !dispatchRoles.getRoles().includes(name)) return false;
    const role = dispatchRoles.getRoleDefinition(name);
    if (!role.dispatchable || !role.dispatch) return false;
    const timeout = dispatchRoles.getTimeoutForModel(dispatchRoles.getValidModelForRole(name));
    registry.registerClient(
      new RoleDispatchLocalMcp(ctx, name, role.dispatch, name, DISPATCH_TOOL).setTimeout(timeout)
    );
    ctx.logger?.debug("mcp role-agent mounted", { role: name });
    return true;
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
