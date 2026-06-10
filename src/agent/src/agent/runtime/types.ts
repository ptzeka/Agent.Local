import type { IdentityContext, Principal } from "../identity/types.js";
import type { InputInbox } from "../input-inbox.js";
import type { McpClientRegistry } from "../registries/mcp-registry.js";
import type { ModelRegistry } from "../registries/model-registry.js";
import type { Orchestrator } from "../orchestrator.js";
import type { Session } from "../session.js";
import type { SessionManager } from "../session-manager.js";
import type { SessionStore } from "../session-store.js";
import type { ToolDescriptor } from "../providers/provider.js";
import type { Workspace, WorkspaceRegistry } from "../registries/workspace-registry.js";

export interface AgentRuntimeQueryable {
  getSession(): Session;
  getWorkspace(): Workspace;
  getRegistry(): ModelRegistry;
  getMcpClientRegistry(): McpClientRegistry;
  getToolDescriptors(): ToolDescriptor[];
}

export interface AgentRuntimeDeps {
  registry: ModelRegistry;
  mcpRegistry: McpClientRegistry;
  sessionsDir: string;
  workspaceRoot: string;
  mcpConfigPath: string;
  credentials?: IdentityContext;
}

export interface RuntimeContext {
  readonly registry: ModelRegistry;
  readonly mcpRegistry: McpClientRegistry;
  readonly sessionsDir: string;
  readonly workspaceRoot: string;
  readonly mcpConfigPath: string;
  readonly credentials: IdentityContext;

  store: SessionStore | undefined;
  workspaces: WorkspaceRegistry | undefined;
  user: Principal | undefined;
  session: Session | undefined;
  workspace: Workspace | undefined;
  toolDescriptors: ToolDescriptor[] | undefined;
  orchestrator: Orchestrator | undefined;
  inbox: InputInbox | undefined;
  sessionManager: SessionManager | undefined;
}

/**
 * A single step in the initialize pipeline.
 *
 * Each handler receives the context accumulated so far and a `next` function
 * that advances the chain. To short-circuit (e.g. on a fatal auth failure),
 * return without calling next. To enrich and continue, mutate ctx then call
 * next.
 *
 * Order matters: earlier middleware runs first and sees an empty context;
 * later middleware (e.g. preferences enrichment) can build on what earlier
 * ones set.
 */
export interface IMiddleware {
  initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void>;
}
