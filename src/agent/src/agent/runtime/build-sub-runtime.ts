import type { SubRuntimeRefs } from "../runners/subsession.js";
import { AgentRuntime } from "./agent-runtime.js";
import { McpRegistryMiddleware } from "./middleware/mcp-registry.js";
import { EventingMiddleware } from "./middleware/eventing.js";
import { ChildSessionMiddleware } from "./middleware/child-session.js";
import { ContextMiddleware } from "./middleware/context.js";
import { ConversationMiddleware } from "./middleware/conversation.js";
import { InheritedUserMiddleware } from "./middleware/inherited-user.js";
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
 * Compose a sub-session runtime — the same pipeline the CLI builds for a
 * top-level session, with three steps swapped for their parent-fed variants:
 *
 *   Identity + Anonymous  →  InheritedUserMiddleware   (adopt the parent's user)
 *   Session (open/resume)  →  ChildSessionMiddleware    (mint a parent-linked child)
 *   Context                →  ContextMiddleware({ false }) (snapshot without sub-tools)
 *
 * Everything else is the unmodified assembly chain, so the child gets its OWN
 * Orchestrator (a unique runner), its own inbox, and a real — but capped-at-0 —
 * SessionManager. Cap 0 means every spawn it receives is rejected, which is the
 * one-level-deep guard: a sub-session cannot spawn grandchildren.
 *
 * Returns the runtime UNBUILT (mirrors the CLI's buildRuntime); the caller
 * awaits `.build()` then drives a single `dispatchAsync` — the headless lifecycle.
 */
export function buildSubRuntime(deps: AgentRuntimeDeps, refs: SubRuntimeRefs): AgentRuntime {
  // The cancellation parent is the SPAWN's derived signal, not `deps`'s —
  // that's the top-level closure, whose parentSignal is the process root.
  const childDeps: AgentRuntimeDeps = {
    ...deps,
    parentSignal: refs.parentSignal ?? deps.parentSignal,
  };
  return new AgentRuntime(childDeps)
    // No parent bus: a child is its own event root. Its events reach the parent
    // through the executor MCP bridge onto the turn, not by inheriting the host's.
    .add(new EventingMiddleware())
    .add(new LoggerMiddleware({ logger: deps.logger }))
    .add(new ConfigurationMiddleware({ configPath: deps.configPath }))
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
    // Standing context seeds the child's FRESH conversation, so it rides on
    // the conversation step rather than the session step.
    .add(new ConversationMiddleware({ standingContext: refs.standingContext }))
    .add(new McpRegistryMiddleware({ role: deps.orchestratorRole }))
    .add(new OrchestratorMiddleware({ includeSubSessions: false, role: deps.orchestratorRole }))
    .add(new ContextMiddleware({ roleName: deps.orchestratorRole, includeSubSessions: false }))
    .add(new InputInboxMiddleware())
    .add(new SessionManagerMiddleware({ maxActivePerParent: 0 }));
}
