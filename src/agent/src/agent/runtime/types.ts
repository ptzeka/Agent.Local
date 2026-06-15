import type { Conversation } from "../conversation/conversation.js";
import type { IdentityContext } from "../identity/types.js";
import type { McpClientRegistry } from "../registries/mcp-registry.js";
import type { Session } from "../session/session.js";
import type { Workspace } from "../registries/workspace-registry.js";
import type { Eventing } from "@agent-local/common/eventing";
import { ConfigurationRegistry } from "../registries/configuration-registry.js";
import { ProvidersRegistry, ModelRegistry } from "../registries/index.js";
import { ContextLoader } from "../context/context-loader.js";
import { ILogger } from "@agent-local/common/ilogger";
import type { Container } from "@agent-local/common/container";

export interface AgentRuntimeQueryable {
  getSession(): Session;
  getConversation(): Conversation;
  getWorkspace(): Workspace;
  getModelsRegistry(): ModelRegistry;
  getConfigurationRegistry(): ConfigurationRegistry;
  getProvidersRegistry(): ProvidersRegistry;
  getMcpClientRegistry(): McpClientRegistry;
  getContextLoader(): ContextLoader;
  getLogger(): ILogger;
  // a turn chains its own bus under this one, so turn events bubble up through the runtime to the host
  getEvents(): Eventing;
}

export interface AgentRuntimeDeps {
  configPath: string;
  orchestratorRole: "orchestrator" | "executor";
  sessionsDir: string;
  workspaceRoot: string;
  sandboxRoot: string;
  mcpConfigPath: string;
  logger: ILogger;
  credentials?: IdentityContext;
  // ancestor cancel reaches everything this runtime owns; omitted, the runtime is its own root
  parentSignal?: AbortSignal;
  // host's bus; the runtime chains its own under it, so cancellation flows down and events bubble up
  eventing?: Eventing;
}

export interface RuntimeContext {
  // per-runtime service container: ContainerMiddleware creates it first, later steps set() services, consumers get()
  registry: Container;
  readonly configPath: string;
  readonly sessionsDir: string;
  readonly workspaceRoot: string;
  readonly sandboxRoot: string;
  readonly mcpConfigPath: string;
  readonly credentials: IdentityContext;
  logger: ILogger;
  // steps hand this to resources that must die with the runtime (MCP clients, sub-session children)
  readonly runtimeSignal: AbortSignal;
  // chained under the host's by EventingMiddleware; steps and the orchestrator publish here
  eventing: Eventing | undefined;
}

// return without calling next to short-circuit (e.g. fatal auth failure); mutate ctx then call next to continue
// order matters: a later step builds on what earlier ones set
export interface IMiddleware {
  initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void>;
}
