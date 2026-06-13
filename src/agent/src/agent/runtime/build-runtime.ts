import { buildSubRuntime } from "./build-sub-runtime.js";
import { AgentRuntime } from "./agent-runtime.js";
import { AnonymousMiddleware } from "./middleware/anonymous.js";
import { McpRegistryMiddleware } from "./middleware/mcp-registry.js";
import { ContextMiddleware } from "./middleware/context.js";
import { ConversationMiddleware } from "./middleware/conversation.js";
import { IdentityMiddleware } from "./middleware/identity.js";
import { SessionMiddleware } from "./middleware/session.js";
import { InputInboxMiddleware } from "./middleware/input-inbox.js";
import { LoggerMiddleware } from "./middleware/logger.js";
import { OrchestratorMiddleware } from "./middleware/orchestrator.js";
import { SessionManagerMiddleware } from "./middleware/session-manager.js";
import { StoreMiddleware } from "./middleware/store.js";
import { ConfigurationMiddleware } from "./middleware/configuration.js"
import { WorkspaceRegistryMiddleware } from "./middleware/workspace-registry.js";
import type { AgentRuntimeDeps } from "./types.js";
import { ProvidersMiddleware } from "./middleware/providers.js";
import { ModelsMiddleware } from "./middleware/models.js";

/**
 * Build an AgentRuntime with the standard pipeline. Every subsystem the runtime
 * owns is produced by a step here — build() constructs nothing itself:
 *   LoggerMiddleware            — initialize the logger
 *   StoreMiddleware             — open the on-disk session store
 *   WorkspaceRegistryMiddleware — create the workspace → root/context map
 *   IdentityMiddleware          — decode JWT from AGENT_API_TOKEN if present
 *   AnonymousMiddleware         — fall back to anonymous when no creds resolve
 *   SessionMiddleware           — open or resume the session, stamp session.user
 *   ConversationMiddleware      — open the session's transcript (rolling JSONL file)
 *   OrchestratorMiddleware      — assemble tool descriptors and build the orchestrator
 *   ContextMiddleware           — snapshot the sent context, stamp session.contextHash
 *   InputInboxMiddleware        — create the external input injection seam
 *   SessionManagerMiddleware    — build the sub-session manager
 *
 * Host-agnostic by design: no step may assume a CLI (or any other host). Every
 * entry point — CLI today, single-task job or a cloud RuntimeManager routing by
 * session directory later — composes the same pipeline; hosts stay thin wrappers.
 */
export function buildRuntime(deps: AgentRuntimeDeps, sessionId?: string): AgentRuntime {
    return new AgentRuntime(deps)
    .add(new LoggerMiddleware())
    .add(new ConfigurationMiddleware({ configPath: deps.configPath }))
    .add(new ProvidersMiddleware())
    .add(new ModelsMiddleware())
    .add(new StoreMiddleware())
    .add(new WorkspaceRegistryMiddleware())
        .add(new IdentityMiddleware())
        .add(new AnonymousMiddleware())
        .add(new SessionMiddleware({ sessionId }))
    .add(new ConversationMiddleware())
    .add(new McpRegistryMiddleware({ role: deps.orchestratorRole }))
    .add(new OrchestratorMiddleware({ includeSubSessions: true, role: deps.orchestratorRole }))
    .add(new ContextMiddleware({ roleName: deps.orchestratorRole }))
    .add(new InputInboxMiddleware())
    .add(new SessionManagerMiddleware({ subRuntimeFactory: (refs) => buildSubRuntime(deps, refs) }));
}
