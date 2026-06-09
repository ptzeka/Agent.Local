import type { IdentityContext, Principal } from "../identity/types.js";
import type { InputInbox } from "../input-inbox.js";
import type { McpToolClient } from "../mcp-client.js";
import type { ModelRegistry } from "../model-registry.js";
import type { Orchestrator } from "../orchestrator.js";
import type { Session } from "../session.js";
import type { SessionManager } from "../session-manager.js";
import type { SessionStore } from "../session-store.js";
import type { Workspace, WorkspaceRegistry } from "../workspace-registry.js";

/**
 * Fixed infrastructure handed to AgentRuntime at construction time.
 * These don't change between sessions.
 */
export interface AgentRuntimeDeps {
  registry: ModelRegistry;
  tools: McpToolClient;
  /** Directory where session JSON files are persisted. */
  sessionsDir: string;
  /** Filesystem root the agent reads/writes. Used to load project context. */
  workspaceRoot: string;
  /** Optional credentials forwarded into the identity pipeline. */
  credentials?: IdentityContext;
}

/**
 * Mutable context that flows through the initialize pipeline.
 *
 * AgentRuntime seeds ONLY the infrastructure fields (the raw deps) before
 * running the pipeline. Every subsystem the runtime ends up owning is built by
 * a middleware step that reads what earlier steps wrote and writes its own
 * output. build() then reads the owned fields back out of the context.
 *
 * Pipeline convention (each step reads earlier steps' output from ctx):
 *   StoreMiddleware             reads  sessionsDir         → writes store
 *   WorkspaceRegistryMiddleware                            → writes workspaces
 *   IdentityMiddleware          reads  credentials         → writes user
 *   AnonymousMiddleware         reads  user                → writes user (fallback)
 *   SessionMiddleware           reads  store/workspaces/user → writes session + workspace
 *   OrchestratorMiddleware      reads  registry/tools      → writes orchestrator
 *   InputInboxMiddleware                                   → writes inbox
 *   SessionManagerMiddleware    reads  orchestrator/inbox/store → writes sessionManager
 */
export interface RuntimeContext {
  // Infrastructure — the raw deps, seeded by AgentRuntime, read-only for middleware
  readonly registry: ModelRegistry;
  readonly tools: McpToolClient;
  readonly sessionsDir: string;
  readonly workspaceRoot: string;
  readonly credentials: IdentityContext;

  // Populated by middleware during build()
  store: SessionStore | undefined;
  workspaces: WorkspaceRegistry | undefined;
  user: Principal | undefined;
  session: Session | undefined;
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
