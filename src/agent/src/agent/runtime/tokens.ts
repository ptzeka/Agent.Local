import { token } from "@agent-local/common/container";
import type { McpClientRegistry } from "../registries/mcp-registry.js";
import type { ProvidersRegistry, ModelRegistry } from "../registries/index.js";
import type { ConfigurationRegistry } from "../registries/configuration-registry.js";
import type { SessionStore } from "../session/session-store.js";
import type { ContextLoader } from "../context/context-loader.js";
import type { WorkspaceRegistry, Workspace } from "../registries/workspace-registry.js";
import type { Principal } from "../identity/types.js";
import type { Session } from "../session/session.js";
import type { Conversation } from "../conversation/conversation.js";
import type { Orchestrator } from "../runners/orchestrator.js";
import type { InputInbox } from "../runners/input-inbox.js";
import type { SessionManager } from "../session/session-manager.js";
import type { IRunnerMiddleware } from "../runners/middleware/runner-middleware.js";
import type { MetricsRegistry } from "./metrics/metrics-registry.js";

// one token per runtime-scoped service; middleware set() these into ctx.registry, consumers get() them
export const ConfigurationToken = token<ConfigurationRegistry>("configurationRegistry");
export const ProvidersToken = token<ProvidersRegistry>("providerRegistry");
export const ModelsToken = token<ModelRegistry>("modelsRegistry");
export const StoreToken = token<SessionStore>("store");
export const ContextLoaderToken = token<ContextLoader>("contextLoader");
export const WorkspacesToken = token<WorkspaceRegistry>("workspaces");
export const McpRegistryToken = token<McpClientRegistry>("mcpRegistry");
export const UserToken = token<Principal>("user");
export const SessionToken = token<Session>("session");
export const ConversationToken = token<Conversation>("conversation");
export const WorkspaceToken = token<Workspace>("workspace");
export const OrchestratorToken = token<Orchestrator>("orchestrator");
export const InboxToken = token<InputInbox>("inbox");
export const SessionManagerToken = token<SessionManager>("sessionManager");
// group handle: runner-middleware units register via .by(), AgentRuntime folds them with getAll() around each turn
export const RunnerMiddlewareToken = token<IRunnerMiddleware>("runnerMiddleware");
// runtime-scoped token tally; TurnCounterMiddleware writes it, readouts (cost/context) read it
export const MetricsRegistryToken = token<MetricsRegistry>("metricsRegistry");
