import type { SubRuntimeRefs } from "../runners/subsession.js";
import { AgentRuntime } from "./agent-runtime.js";
import { McpRegistryMiddleware } from "./middleware/mcp-registry.js";
import { ContainerMiddleware } from "./middleware/container.js";
import { EventingMiddleware } from "./middleware/eventing.js";
import { ChildSessionMiddleware } from "./middleware/child-session.js";
import { ContextMiddleware } from "./middleware/context.js";
import { ConversationMiddleware } from "./middleware/conversation.js";
import { InheritedUserMiddleware } from "./middleware/inherited-user.js";
import { InputInboxMiddleware } from "./middleware/input-inbox.js";
import { LoggerMiddleware } from "./middleware/logger.js";
import { OrchestratorMiddleware } from "./middleware/orchestrator.js";
import { MetricsRegistryMiddleware } from "./middleware/metrics-registry.js";
import { RunnerPipelineMiddleware } from "./middleware/runner-pipeline.js";
import { SessionManagerMiddleware } from "./middleware/session-manager.js";
import { StoreMiddleware } from "./middleware/store.js";
import { ConfigurationMiddleware } from "./middleware/configuration.js"
import { WorkspaceRegistryMiddleware } from "./middleware/workspace-registry.js";
import type { AgentRuntimeDeps } from "./types.js";
import { ProvidersMiddleware } from "./middleware/providers.js";
import { ModelsMiddleware } from "./middleware/models.js";

// the top-level pipeline with three steps swapped for parent-fed variants (inherited user, child session, sub-tool-free context)
// the SessionManager is capped at 0 so every spawn is rejected — the one-level-deep guard against grandchildren
// returned UNBUILT like buildRuntime; the caller awaits .build() then drives one dispatchAsync
export function buildSubRuntime(deps: AgentRuntimeDeps, refs: SubRuntimeRefs): AgentRuntime {
  // cancellation parent is the spawn's derived signal, not deps' process-root signal
  const childDeps: AgentRuntimeDeps = {
    ...deps,
    parentSignal: refs.parentSignal ?? deps.parentSignal,
    // a sub-run has no live renderer of its own; it reports through the executor bridge, so it stays collect-only
    streamOutput: false,
    // honour the caller's role: the executor dispatch needs EXECUTOR_ROLE (no dispatch seam, write tools instead),
    // while the subsession factory pins "orchestrator" at its own call site so it never inherits workflow-orchestrator
    orchestratorRole: deps.orchestratorRole,
  };
  return new AgentRuntime(childDeps)
    .add(new ContainerMiddleware())
    // no parent bus: a child is its own event root, reaching the parent via the executor MCP bridge
    .add(new EventingMiddleware())
    .add(new LoggerMiddleware({ logger: deps.logger }))
    .add(new ConfigurationMiddleware({ config: deps.config }))
    .add(new ProvidersMiddleware())
    .add(new ModelsMiddleware())
    .add(new StoreMiddleware())
    .add(new WorkspaceRegistryMiddleware())
    .add(new InheritedUserMiddleware(refs.user))
    .add(
      new ChildSessionMiddleware({
        sessionId: refs.sessionId,
        parentSessionId: refs.parentSessionId,
        workspaceId: refs.workspaceId,
      })
    )
    // standing context seeds the child's fresh conversation, so it rides the conversation step, not the session step
    .add(new ConversationMiddleware({ standingContext: refs.standingContext }))
    .add(new MetricsRegistryMiddleware())
    // before the MCP step (same as the parent pipeline); capped at 0 so this leaf coordinator refuses every spawn
    .add(new SessionManagerMiddleware({ maxActivePerParent: 0 }))
    .add(new McpRegistryMiddleware({ role: childDeps.orchestratorRole }))
    .add(new OrchestratorMiddleware({ role: childDeps.orchestratorRole }))
    .add(new RunnerPipelineMiddleware())
    .add(new ContextMiddleware({ roleName: childDeps.orchestratorRole, includeSubSessions: false }))
    .add(new InputInboxMiddleware());
}
