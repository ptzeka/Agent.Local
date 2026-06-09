import type { IdentityContext, Principal } from "../identity/types.js";
import type { McpToolClient } from "../mcp-client.js";
import type { ModelRegistry } from "../model-registry.js";
import type { Session } from "../session.js";
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
 * AgentRuntime builds the infrastructure fields (store, workspaces, credentials)
 * before running the pipeline. Middleware reads them to do its work and writes
 * the output fields (user, session, workspace) that the runtime will own after
 * build().
 *
 * Pipeline convention:
 *   IdentityMiddleware   reads  credentials → writes user
 *   AnonymousMiddleware  reads  user        → writes user (fallback)
 *   SessionMiddleware    reads  user        → writes session + workspace
 */
export interface RuntimeContext {
  // Infrastructure — created by AgentRuntime, read-only for middleware
  readonly store: SessionStore;
  readonly workspaces: WorkspaceRegistry;
  readonly workspaceRoot: string;
  readonly credentials: IdentityContext;

  // Populated by middleware during build()
  user: Principal | undefined;
  session: Session | undefined;
  workspace: Workspace | undefined;
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
