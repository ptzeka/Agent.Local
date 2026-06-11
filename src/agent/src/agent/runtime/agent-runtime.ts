import { InputInbox } from "../runners/input-inbox.js";
import { Orchestrator, type RunOptions, type RunResult } from "../runners/orchestrator.js";
import type { ProjectContext } from "../context/context-loader.js";
import type { ChatMessage, ToolDescriptor } from "../providers/provider.js";
import type { Session } from "../session/session.js";
import { SessionManager } from "../session/session-manager.js";
import { SessionStore, type SessionSummary } from "../session/session-store.js";
import { Summarizer, buildSummaryMessage, isSummaryMessage } from "../runners/summarizer.js";
import type { SubSessionNotificationListener } from "../runners/subsession.js";
import type { Workspace } from "../registries/workspace-registry.js";
import { WorkspaceRegistry } from "../registries/workspace-registry.js";
import type { AgentRuntimeDeps, AgentRuntimeQueryable, IMiddleware, RuntimeContext } from "./types.js";
import type { ModelRegistry } from "../registries/model-registry.js";
import type { McpClientRegistry } from "../registries/mcp-registry.js";
import type { Logger } from "../../common/logger.js";
import { ConfigurationRegistry } from "../registries/configuration-registry.js";
import { ProvidersRegistry } from "../registries/providers-registry.js";

export interface ResetResult {
  context: ProjectContext | null;
  contextChanged: boolean;
}

export interface CompactResult {
  summarizedCount: number;
  skipped: boolean;
  summary: string | null;
}

/**
 * AgentRuntime — the stateful owner of a single session.
 *
 * Replaces the old Initializer with a fluent middleware pipeline that runs
 * once during build() to set up the session, then exposes a clean set of
 * per-session operations.
 *
 * Construction (via the fluent builder):
 *
 *   const runtime = await new AgentRuntime({ registry, tools, sessionsDir, workspaceRoot })
 *     .add(new StoreMiddleware())
 *     .add(new WorkspaceRegistryMiddleware())
 *     .add(new SessionMiddleware({ sessionId }))
 *     .add(new OrchestratorMiddleware({ includeSubSessions: true }))
 *     .add(new InputInboxMiddleware())
 *     .add(new SessionManagerMiddleware())
 *     .build();
 *
 * Per-turn operations:
 *   await runtime.dispatchAsync(input, { onEvent });
 *   runtime.injectInput(content);
 *   await runtime.finalize();     // explicit persist (called automatically by dispatchAsync)
 *   await runtime.reset();
 *   await runtime.compact();
 *
 * Ownership tree (mirrors the old Initializer tree, now per-session):
 *   AgentRuntime   (stateful session owner)
 *   ├─ Session                 the live conversation state
 *   ├─ Workspace               resolved project context
 *   ├─ Orchestrator            ONE stateless instance drives this session
 *   ├─ InputInbox              external input injection seam
 *   ├─ SessionStore            persistence
 *   ├─ WorkspaceRegistry       workspace → root/context map
 *   └─ SessionManager          owns sub-sessions spawned within this session
 */
export class AgentRuntime implements AgentRuntimeQueryable {
  private readonly middlewares: IMiddleware[] = [];

  // Populated by build() — all required after construction
  private logger!: Logger;
  private session!: Session;
  private workspace!: Workspace;
  private modelsRegistry!: ModelRegistry;
  private configurationRegistry!: ConfigurationRegistry;
  private providersRegistry!: ProvidersRegistry;
  private mcpClientRegistry!: McpClientRegistry;
  private orchestrator!: Orchestrator;
  private inbox!: InputInbox;
  private sessionManager!: SessionManager;
  private store!: SessionStore;
  private workspaces!: WorkspaceRegistry;

  constructor(private readonly deps: AgentRuntimeDeps) {}

  // --------------------------------------------------------------------------
  // Fluent builder
  // --------------------------------------------------------------------------

  add(middleware: IMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  /**
   * Seed the context with the raw deps, run the initialize pipeline, then claim
   * ownership of every subsystem the pipeline built. build() constructs nothing
   * itself — each subsystem is produced by a middleware step (see RuntimeContext
   * for the pipeline convention). Must be called (and awaited) before any other
   * method.
   */
  async build(): Promise<this> {
    const ctx: RuntimeContext = {
      sessionsDir: this.deps.sessionsDir,
      workspaceRoot: this.deps.workspaceRoot,
      sandboxRoot: this.deps.sandboxRoot,
      mcpConfigPath: this.deps.mcpConfigPath,
      credentials: this.deps.credentials ?? {},
      configurationRegistry: undefined,
      modelsRegistry: undefined,
      mcpRegistry: undefined,
      providerRegistry: undefined,
      logger: undefined,
      store: undefined,
      workspaces: undefined,
      user: undefined,
      session: undefined,
      workspace: undefined,
      orchestrator: undefined,
      inbox: undefined,
      sessionManager: undefined,
    };

    await this.runPipeline(ctx, 0);

    // Every owned field must have been set by a pipeline step. Report all gaps
    // at once so a misordered/incomplete pipeline is easy to fix.
    const missing = [
      !ctx.logger && "logger (LoggerMiddleware)",
      !ctx.store && "store (StoreMiddleware)",
      !ctx.workspaces && "workspaces (WorkspaceRegistryMiddleware)",
      !ctx.session && "session (SessionMiddleware)",
      !ctx.workspace && "workspace (SessionMiddleware)",
      !ctx.orchestrator && "orchestrator (OrchestratorMiddleware)",
      !ctx.inbox && "inbox (InputInboxMiddleware)",
      !ctx.sessionManager && "sessionManager (SessionManagerMiddleware)",
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(
        `AgentRuntime.build(): pipeline left these unset: ${missing.join(", ")}. ` +
          "Add the listed step(s) to the pipeline."
      );
    }

    this.configurationRegistry = ctx.configurationRegistry!;
    this.logger = ctx.logger!;
    this.modelsRegistry = ctx.modelsRegistry!;
    this.mcpClientRegistry = ctx.mcpRegistry!;
    this.providersRegistry = ctx.providerRegistry!;
    this.store = ctx.store!;
    this.workspaces = ctx.workspaces!;
    this.session = ctx.session!;
    this.workspace = ctx.workspace!;
    this.orchestrator = ctx.orchestrator!;
    this.inbox = ctx.inbox!;
    this.sessionManager = ctx.sessionManager!;

    // Wire the runtime into the orchestrator so it can query for dependencies
    this.orchestrator.setRuntime(this);

    return this;
  }

  // --------------------------------------------------------------------------
  // Per-turn operations
  // --------------------------------------------------------------------------

  /**
   * Run one user turn. Manages the running-guard, status transitions, the turn
   * counter, and calls finalize() in the finally block so every exit path
   * (clean, capped, thrown) persists the session.
   */
  async dispatchAsync(input: string, options: RunOptions = {}): Promise<RunResult> {
    if (this.session.status === "running") {
      throw new Error(`Session "${this.session.sessionId}" is already running a turn.`);
    }

    this.session.status = "running";

    const runOptions: RunOptions = {
      ...options,
      coordinator: this.sessionManager,
      pullInjectedPrompts: () => this.inbox.drain(this.session.sessionId),
    };

    try {
      const result = await this.orchestrator.run(input, runOptions);
      this.session.status = result.outcome === "satisfied" ? "awaiting-input" : "error";
      this.session.counters.turns += 1;
      return result;
    } catch (err) {
      this.session.status = "error";
      throw err;
    } finally {
      await this.finalize();
    }
  }

  /**
   * Inject a prompt from outside the orchestrator loop. The prompt is queued
   * and drained at the start of the next orchestrator iteration — safe to call
   * whether or not a turn is currently in flight.
   */
  injectInput(content: string, source?: string): void {
    this.inbox.push(this.session.sessionId, content, source);
  }

  /**
   * Persist the current session state. Called automatically by dispatchAsync,
   * reset, and compact — expose as public so callers can flush ad-hoc changes.
   */
  async finalize(): Promise<void> {
    this.session.updatedAt = Date.now();
    await this.store.save(this.session);
  }

  /**
   * Clear the conversation transcript and re-read the workspace context from
   * disk, picking up any edits to agentcontext.md since last load.
   */
  async reset(): Promise<ResetResult> {
    if (this.session.status === "running") {
      throw new Error(`Session "${this.session.sessionId}" is running a turn; cannot reset now.`);
    }

    const before = this.workspace.projectContext?.content ?? null;
    this.workspace = await this.workspaces.reload(this.session.workspaceId);
    const after = this.workspace.projectContext?.content ?? null;

    this.session.conversation.length = 0;
    this.session.status = "idle";
    this.session.counters.turns = 0;
    await this.finalize();

    return { context: this.workspace.projectContext, contextChanged: before !== after };
  }

  /**
   * Fold the entire conversation into a single summary checkpoint. Unlike the
   * orchestrator's automatic threshold-gated summarization, this collapses the
   * whole transcript — no verbatim tail is kept. Refused while a turn is in
   * flight to avoid racing the orchestrator's in-place conversation mutation.
   */
  async compact(options: { signal?: AbortSignal } = {}): Promise<CompactResult> {
    if (this.session.status === "running") {
      throw new Error(`Session "${this.session.sessionId}" is running a turn; cannot compact now.`);
    }

    const messages = this.session.conversation;
    if (messages.length === 0 || (messages.length === 1 && isSummaryMessage(messages[0]))) {
      return { summarizedCount: 0, skipped: true, summary: null };
    }
    
    const summarizer = new Summarizer(this);
    const summaryText = await summarizer.summarize(messages, { signal: options.signal });
    const summarizedCount = messages.length;

    this.session.conversation.length = 0;
    this.session.conversation.push(buildSummaryMessage(summaryText, summarizedCount));
    await this.finalize();

    return { summarizedCount, skipped: false, summary: summaryText };
  }

  // --------------------------------------------------------------------------
  // Sub-session coordination
  // --------------------------------------------------------------------------

  /**
   * Subscribe to sub-session completions. Returns an unsubscribe function.
   * The REPL listens here so finished background tasks surface out-of-band.
   */
  onSubSessionEvent(listener: SubSessionNotificationListener): () => void {
    return this.sessionManager.onNotification(listener);
  }

  /**
   * Block until every sub-session spawned by THIS session has settled. Used
   * by the headless single-run path to drain background tasks before exit.
   */
  awaitSubSessions(): Promise<void> {
    return this.sessionManager.awaitActive(this.session.sessionId);
  }

  /**
   * Block until every sub-session across the internal session manager has
   * settled. Called on normal process exit so no detached task is abandoned.
   */
  awaitAllSubSessions(): Promise<void> {
    return this.sessionManager.awaitAllActive();
  }

  // --------------------------------------------------------------------------
  // Queries
  // --------------------------------------------------------------------------

  getSession(): Session {
    return this.session;
  }

  getWorkspace(): Workspace {
    return this.workspace;
  }

  history(): readonly ChatMessage[] {
    return this.session.conversation;
  }

  getWorkspaceContext(): ProjectContext | null {
    return this.workspace.projectContext;
  }

  getModelsRegistry(): ModelRegistry {
    return this.modelsRegistry;
  }

  getConfigurationRegistry(): ConfigurationRegistry {
    return this.configurationRegistry;
  }

  getProvidersRegistry(): ProvidersRegistry {
    return this.providersRegistry;
  }

  getMcpClientRegistry(): McpClientRegistry {
    return this.mcpClientRegistry;
  }

  getOrchestrator(): Orchestrator {
    return this.orchestrator;
  }

  getLogger(): Logger {
    return this.logger;
  }

  // --------------------------------------------------------------------------
  // Static utilities (pre-session)
  // --------------------------------------------------------------------------

  /**
   * List persisted top-level sessions for a session picker. Static so it can
   * be called before a runtime instance is built — the picker runs before the
   * user has chosen which session to open or resume.
   */
  static listSavedSessions(sessionsDir: string): Promise<SessionSummary[]> {
    return SessionStore.create(sessionsDir).summaries();
  }

  // --------------------------------------------------------------------------
  // Internal pipeline runner
  // --------------------------------------------------------------------------

  private runPipeline(ctx: RuntimeContext, index: number): Promise<void> {
    if (index >= this.middlewares.length) return Promise.resolve();
    const middleware = this.middlewares[index];
    return middleware.initialize(ctx, () => this.runPipeline(ctx, index + 1));
  }
}
