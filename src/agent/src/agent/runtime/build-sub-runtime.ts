import type { SubRuntimeRefs } from "../subsession.js";
import { AgentRuntime } from "./agent-runtime.js";
import { ChildSessionMiddleware } from "./middleware/child-session.js";
import { ContextMiddleware } from "./middleware/context.js";
import { InheritedUserMiddleware } from "./middleware/inherited-user.js";
import { InputInboxMiddleware } from "./middleware/input-inbox.js";
import { OrchestratorMiddleware } from "./middleware/orchestrator.js";
import { SessionManagerMiddleware } from "./middleware/session-manager.js";
import { StoreMiddleware } from "./middleware/store.js";
import { ToolsMiddleware } from "./middleware/tools.js";
import { WorkspaceRegistryMiddleware } from "./middleware/workspace-registry.js";
import type { AgentRuntimeDeps } from "./types.js";

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
  return new AgentRuntime(deps)
    .add(new StoreMiddleware())
    .add(new WorkspaceRegistryMiddleware())
    .add(new InheritedUserMiddleware(refs.user))
    .add(
      new ChildSessionMiddleware({
        sessionId: refs.sessionId,
        parentSessionId: refs.parentSessionId,
        workspaceId: refs.workspaceId,
        standingContext: refs.standingContext,
      })
    )
    .add(new ToolsMiddleware({ includeSubSessions: false }))
    .add(new ContextMiddleware({ includeSubSessions: false }))
    .add(new OrchestratorMiddleware())
    .add(new InputInboxMiddleware())
    .add(new SessionManagerMiddleware({ maxActivePerParent: 0 }));
}
