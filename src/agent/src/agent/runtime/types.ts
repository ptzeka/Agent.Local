import type { Conversation } from "../conversation/conversation.js";
import type { IdentityContext, Principal } from "../identity/types.js";
import type { InputInbox } from "../runners/input-inbox.js";
import type { McpClientRegistry } from "../registries/mcp-registry.js";
import type { Orchestrator } from "../runners/orchestrator.js";
import type { Session } from "../session/session.js";
import type { SessionManager } from "../session/session-manager.js";
import type { SessionStore } from "../session/session-store.js";
import type { Workspace, WorkspaceRegistry } from "../registries/workspace-registry.js";
import type { Logger } from "../../common/logger.js";
import type { Eventing } from "../../common/eventing.js";
import { ConfigurationRegistry } from "../registries/configuration-registry.js";
import { ProvidersRegistry, ModelRegistry } from "../registries/index.js";
import { ContextLoader } from "../context/context-loader.js";

export interface AgentRuntimeQueryable {
  getSession(): Session;
  getConversation(): Conversation;
  getWorkspace(): Workspace;
  getModelsRegistry(): ModelRegistry;
  getConfigurationRegistry(): ConfigurationRegistry;
  getProvidersRegistry(): ProvidersRegistry;
  getMcpClientRegistry(): McpClientRegistry;
  getContextLoader(): ContextLoader;
  getLogger(): Logger;
  /** This runtime's event bus — a turn chains its own bus under it and publishes
   *  there, so turn events bubble up through the runtime to the host. */
  getEvents(): Eventing;
}

export interface AgentRuntimeDeps {
  configPath: string;
  orchestratorRole: "orchestrator" | "executor";
  sessionsDir: string;
  workspaceRoot: string;
  sandboxRoot: string;
  mcpConfigPath: string;
  credentials?: IdentityContext;
  /** Cancellation chain link — an ancestor cancel reaches everything this
   *  runtime owns. Omitted, the runtime is its own root. */
  parentSignal?: AbortSignal;
  /** Parent event bus — the host's. The runtime chains its OWN bus under this
   *  (parent.add(child)), so its events bubble up to the host. The event mirror
   *  of parentSignal: cancellation flows down, events bubble up. Omitted, the
   *  runtime's bus is its own root with no upward consumer. */
  eventing?: Eventing;
}

export interface RuntimeContext {

  mcpRegistry: McpClientRegistry | undefined;
  readonly configPath: string;
  readonly sessionsDir: string;
  readonly workspaceRoot: string;
  readonly sandboxRoot: string;
  readonly mcpConfigPath: string;
  readonly credentials: IdentityContext;
  /** Owning runtime's scope signal — steps hand it to resources that must die
   *  with the runtime (MCP clients, sub-session children). */
  readonly runtimeSignal: AbortSignal;
  /** This runtime's event bus, chained under the host's by EventingMiddleware —
   *  the upward mirror of runtimeSignal. Steps and the orchestrator publish here. */
  eventing: Eventing | undefined;
  providerRegistry: ProvidersRegistry | undefined;
  modelsRegistry: ModelRegistry | undefined;
  configurationRegistry: ConfigurationRegistry | undefined;
  logger: Logger | undefined;
  store: SessionStore | undefined;
  contextLoader: ContextLoader| undefined,
  workspaces: WorkspaceRegistry | undefined;
  user: Principal | undefined;
  session: Session | undefined;
  conversation: Conversation | undefined;
  workspace: Workspace | undefined;
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
