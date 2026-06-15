import { buildSubRuntime } from "./build-sub-runtime.js";
import { AgentRuntime } from "./agent-runtime.js";
import { ContainerMiddleware } from "./middleware/container.js";
import { AnonymousMiddleware } from "./middleware/anonymous.js";
import { EventingMiddleware } from "./middleware/eventing.js";
import { McpRegistryMiddleware } from "./middleware/mcp-registry.js";
import { ContextMiddleware } from "./middleware/context.js";
import { ConversationMiddleware } from "./middleware/conversation.js";
import { IdentityMiddleware } from "./middleware/identity.js";
import { SessionMiddleware } from "./middleware/session.js";
import { InputInboxMiddleware } from "./middleware/input-inbox.js";
import { LoggerMiddleware } from "./middleware/logger.js";
import { OrchestratorMiddleware } from "./middleware/orchestrator.js";
import { RunnerPipelineMiddleware } from "./middleware/runner-pipeline.js";
import { SessionManagerMiddleware } from "./middleware/session-manager.js";
import { StoreMiddleware } from "./middleware/store.js";
import { ConfigurationMiddleware } from "./middleware/configuration.js"
import { WorkspaceRegistryMiddleware } from "./middleware/workspace-registry.js";
import type { AgentRuntimeDeps } from "./types.js";
import { ProvidersMiddleware } from "./middleware/providers.js";
import { ModelsMiddleware } from "./middleware/models.js";

// every subsystem the runtime owns is produced by a step here, since build() constructs nothing itself
// host-agnostic by design: no step may assume a CLI, so every entry point composes this same pipeline
export function buildRuntime(deps: AgentRuntimeDeps, sessionId?: string): AgentRuntime {
    return new AgentRuntime(deps)
    .add(new ContainerMiddleware())
    .add(new EventingMiddleware({ parent: deps.eventing }))
    .add(new LoggerMiddleware({ logger: deps.logger }))
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
    .add(new RunnerPipelineMiddleware())
    .add(new ContextMiddleware({ roleName: deps.orchestratorRole }))
    .add(new InputInboxMiddleware())
    .add(new SessionManagerMiddleware({ subRuntimeFactory: (refs) => buildSubRuntime(deps, refs) }));
}
