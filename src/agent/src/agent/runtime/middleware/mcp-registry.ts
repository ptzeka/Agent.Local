import path from "node:path";
import { McpClientRegistry } from "../../registries/index.js";
import type { ModelRegistry } from "../../registries/index.js";
import { createFsLocalMcp, createFsReadonlyLocalMcp, FS_SERVER_NAME, FS_READONLY_SERVER_NAME } from "../../synthetic-mcp/fs-server.js";
import { createExcelLocalMcp, createExcelReadonlyLocalMcp, EXCEL_SERVER_NAME, EXCEL_READONLY_SERVER_NAME } from "../../synthetic-mcp/excel-server.js";
import { TurnResultLocalMcp, TURN_RESULT_SERVER_NAME } from "../../synthetic-mcp/turn-result-server.js";
import { createDelayLocalMcp, DELAY_SERVER_NAME } from "../../synthetic-mcp/delay-server.js";
import { RoleDispatchLocalMcp, DISPATCH_TOOL } from "../../synthetic-mcp/role-dispatch-server.js";
import { EVALUATOR_ROLE, EVALUATOR_SERVER_NAME, EVALUATE_TOOL } from "../../runners/evaluator-pass.js";
import { ConfigurationToken, McpRegistryToken, ModelsToken, SessionToken, WorkspaceToken } from "../tokens.js";
import type { RuntimeContext, IMiddleware } from "../types.js";
import { memoryCollectionFor, type Session } from "../../session/session.js";
import { mountExternalMcp, type McpServerDef } from "./external-mcp.js";
import { ResiliencePolicy } from "../../resilience.js";
import { OrchestratorEventTypes } from "../../runners/runner-events.js";

// memomcp is segregated per session: each spawned instance reads/writes only this session's collection
const MEMOMCP_SERVER_NAME = "memomcp";

// a round's tool calls run concurrently, and a role-agent server spawns a whole child runtime per call,
// so the bulkhead is what bounds how many children one server can have in flight at once
const MAX_CONCURRENT_CALLS_PER_SERVER = 4;

// past this many parked calls the model asked one server for more than a round can plausibly need, so refusing
// hands it back a tool-error it can act on instead of a queue it cannot see
const MAX_QUEUED_CALLS_PER_SERVER = 16;

// notices go to the runtime bus, not a turn bus: a breaker outlives the turn that tripped it
function toolResilience(ctx: RuntimeContext): ResiliencePolicy {
  return new ResiliencePolicy("tool", {
    maxConcurrent: MAX_CONCURRENT_CALLS_PER_SERVER,
    maxQueued: MAX_QUEUED_CALLS_PER_SERVER,
    // no wait cap: the server's own toolTimeoutMs already bounds the permit holder, and a second deadline here
    // would only misfire on a legitimately slow agent that is queued behind healthy work

    onNotice: (notice) =>
      ctx.eventing?.publish(OrchestratorEventTypes.WARNING, { message: notice.message }),
  });
}

// builds the MCP registry and registers the in-process synthetic servers (fsmcp, Excel, turnresult)
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
    // one policy per runtime for the tool port; the executor's own registry below shares it, so a server
    // mounted on both sides is one breaker, not two disagreeing about whether it is alive
    const resilience = toolResilience(ctx);
    const mcpRegistry = new McpClientRegistry(sandboxRoot, resilience);
    ctx.registry.set(McpRegistryToken, mcpRegistry);

    const serverTimeout = modelsRegistry.getTimeoutForRole(this.params.role);
    const validMcpClients = modelsRegistry.getValidMcpServersForRole(this.params.role);
    await this.mountServers(
      mcpRegistry,
      validMcpClients,
      ctx,
      serverTimeout
    );

    this.mountRoleAgents(mcpRegistry, modelsRegistry, ctx);
    this.mountEvaluatorSeam(mcpRegistry, modelsRegistry, ctx);

    ctx.logger?.debug("mcp end", { toolCount: mcpRegistry.listTools().length });
    await next();
  }

  // the terminal judge is a dispatch tool the loop's epilogue calls; it is NOT in any role's whitelist, so it
  // never reaches a model's visible surface — mounted only for coordinator (non-dispatchable) roles, so a leaf
  // sub-agent (the executor, or the evaluator's own child run) never carries it and can't recursively self-judge
  private mountEvaluatorSeam(registry: McpClientRegistry, modelsRegistry: ModelRegistry, ctx: RuntimeContext): void {
    if (modelsRegistry.getRoleDefinition(this.params.role).dispatchable) return;
    if (!modelsRegistry.getRoles().includes(EVALUATOR_ROLE)) return;
    const dispatch = modelsRegistry.getRoleDefinition(EVALUATOR_ROLE).dispatch;
    if (!dispatch) return;
    const timeout = modelsRegistry.getTimeoutForRole(EVALUATOR_ROLE);
    registry.registerClient(
      new RoleDispatchLocalMcp(ctx, EVALUATOR_ROLE, dispatch, EVALUATOR_SERVER_NAME, EVALUATE_TOOL).setTimeout(timeout)
    );
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
          }).setTimeout(serverTimeout));
          break;
        case EXCEL_SERVER_NAME:
          registry.registerClient(createExcelLocalMcp({
            session,
            workspace,
            sandboxRoot,
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
        default:
          await this.mountExternal(registry, mcp, externalDefs, ctx, serverTimeout, session);
      }
    }
  }

  // mounts each role named in this role's `agents` list as `<role>__ask`: one call runs that role as a fresh
  // child and gates its answer on the role's `returns`.
  private mountRoleAgents(
    registry: McpClientRegistry,
    modelsRegistry: ModelRegistry,
    ctx: RuntimeContext
  ): void {
    // an agent is a LEAF: a dispatchable role gets no agents of its own, so a chain is at most
    // coordinator → agent and can never recurse, whatever the records happen to grant
    if (modelsRegistry.getRoleDefinition(this.params.role).dispatchable) return;

    for (const name of modelsRegistry.getAgentsForRole(this.params.role)) {
      // self-reference would nest without bound, since every child would mount the same agent again
      if (name === this.params.role) {
        ctx.logger?.warn("mcp role-agent skip — a role cannot be its own agent", { role: name });
        continue;
      }
      // declared-but-ungrantable drops out with a log, matching the unmounted-server semantics above
      const role = modelsRegistry.getRoles().includes(name)
        ? modelsRegistry.getRoleDefinition(name)
        : undefined;
      if (!role?.dispatchable || !role.dispatch) {
        ctx.logger?.warn("mcp role-agent skip — not a dispatchable role with a dispatch record", { role: name });
        continue;
      }
      const timeout = modelsRegistry.getTimeoutForRole(name);
      registry.registerClient(
        new RoleDispatchLocalMcp(ctx, name, role.dispatch, name, DISPATCH_TOOL).setTimeout(timeout)
      );
      ctx.logger?.debug("mcp role-agent mounted", { role: name });
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
