import { randomUUID } from "node:crypto";

import type { Conversation } from "../conversation/conversation.js";
import { InputInbox } from "../runners/input-inbox.js";
import { Orchestrator, type RunOptions, type RunResult } from "../runners/orchestrator.js";
import type { ContextLoader } from "../context/context-loader.js";
import type { ChatMessage } from "../providers/provider.js";
import type { Session } from "../session/session.js";
import { SessionManager } from "../session/session-manager.js";
import { SessionStore, type SessionSummary } from "../session/session-store.js";
import { Summarizer, buildSummaryMessage, isSummaryMessage } from "../runners/summarizer.js";
import type { SubSessionNotification, SubSessionNotificationListener } from "../runners/subsession.js";
import { TurnRunner, type TurnRunnerListener } from "../runners/turn-runner.js";
import type { RunnerListener } from "../runners/runner-events.js";
import type { Workspace } from "../registries/workspace-registry.js";
import { WorkspaceRegistry } from "../registries/workspace-registry.js";
import type { AgentRuntimeDeps, AgentRuntimeQueryable, IMiddleware, RuntimeContext } from "./types.js";
import type { ModelRegistry } from "../registries/model-registry.js";
import type { McpClientRegistry } from "../registries/mcp-registry.js";
import type { Logger } from "../../common/logger.js";
import { ConfigurationRegistry } from "../registries/configuration-registry.js";
import { ProvidersRegistry } from "../registries/providers-registry.js";

export interface ResetResult {
  projectContext: string | null;
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
 *   ├─ Session                 run state (status, counters, links)
 *   ├─ Conversation            the live transcript (rolling JSONL file)
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
  private conversation!: Conversation;
  private workspace!: Workspace;
  private modelsRegistry!: ModelRegistry;
  private configurationRegistry!: ConfigurationRegistry;
  private providersRegistry!: ProvidersRegistry;
  private mcpClientRegistry!: McpClientRegistry;
  private contextLoader!: ContextLoader;
  private orchestrator!: Orchestrator;
  private inbox!: InputInbox;
  private sessionManager!: SessionManager;
  private store!: SessionStore;
  private workspaces!: WorkspaceRegistry;

  // Turn loop (optional — hosts opt in via startTurnLoop; headless single runs
  // keep calling dispatchAsync directly and never construct these).
  private turnRunner: TurnRunner | null = null;
  private unsubscribeTurnWake: (() => void) | null = null;

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
      configPath: this.deps.configPath,
      sessionsDir: this.deps.sessionsDir,
      workspaceRoot: this.deps.workspaceRoot,
      sandboxRoot: this.deps.sandboxRoot,
      mcpConfigPath: this.deps.mcpConfigPath,
      credentials: this.deps.credentials ?? {},
      configurationRegistry: undefined,
      modelsRegistry: undefined,
      mcpRegistry: undefined,
      contextLoader: undefined,
      providerRegistry: undefined,
      logger: undefined,
      store: undefined,
      workspaces: undefined,
      user: undefined,
      session: undefined,
      conversation: undefined,
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
      !ctx.conversation && "conversation (ConversationMiddleware)",
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
    this.contextLoader = ctx.contextLoader!;
    this.providersRegistry = ctx.providerRegistry!;
    this.store = ctx.store!;
    this.workspaces = ctx.workspaces!;
    this.session = ctx.session!;
    this.conversation = ctx.conversation!;
    this.workspace = ctx.workspace!;
    this.orchestrator = ctx.orchestrator!;
    this.inbox = ctx.inbox!;
    this.sessionManager = ctx.sessionManager!;

    // Wire the runtime into the orchestrator so it can query for dependencies
    this.orchestrator.setRuntime(this);

    // reset() re-runs build(), which constructs a NEW SessionManager — an
    // active turn loop's wake subscription would silently point at the dead
    // manager, so re-bind it to the one that will actually fire.
    this.rewireTurnWake();

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
      // A user stop is an abandonment, not a failure — the session must come
      // back ready for input, not flagged broken.
      this.session.status = options.signal?.aborted ? "awaiting-input" : "error";
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

  // --------------------------------------------------------------------------
  // Turn loop — multi-producer scheduling over dispatchAsync
  // --------------------------------------------------------------------------

  /**
   * Start the session's turn loop and return its TurnRunner. From here on the
   * runner's pump is the sole caller of dispatchAsync: hosts SUBMIT turns
   * (user input, API calls) instead of dispatching, and settling sub-sessions
   * auto-wake the session — their report is appended as a mid-turn ROUND when
   * a turn is in flight, or queued as a coalesced wake TURN when idle. Either
   * way the report enters the conversation, so the orchestrator actually
   * reasons over the child's result instead of it dying in a log line.
   *
   * Idempotent; `onEvent` is bound on first call. Headless single runs simply
   * never call this and keep the direct dispatchAsync path.
   */
  startTurnLoop(options: { onEvent?: RunnerListener; onTurnEvent?: TurnRunnerListener } = {}): TurnRunner {
    if (this.turnRunner) return this.turnRunner;

    this.turnRunner = new TurnRunner(
      async (content, signal) => {
        const result = await this.dispatchAsync(content, { onEvent: options.onEvent, signal });
        return { outcome: result.outcome, summary: result.finalMessage.content };
      },
      { onEvent: options.onTurnEvent }
    );

    this.rewireTurnWake();
    this.turnRunner.start();
    return this.turnRunner;
  }

  /**
   * Complete stoppage — the user's "stop": abort the in-flight turn, flush
   * every queued turn, and cancel every running sub-session of this session.
   * Children are swept FIRST and through finalize(), whose settle guard
   * suppresses their report-back notifications — otherwise a dying child
   * could enqueue a wake turn into the queue being flushed.
   */
  stopAllWork(): { cancelledTurns: number; cancelledSubSessions: number } {
    const cancelledSubSessions = this.sessionManager.cancelActive(this.session.sessionId);
    const cancelledTurns = this.turnRunner?.cancelAll() ?? 0;
    return { cancelledTurns, cancelledSubSessions };
  }

  /**
   * Stop the turn loop: unhook the wake subscription and let the in-flight
   * turn finish. Pending turns stay in the runner's queue (snapshot-able by a
   * future resume path); they are simply no longer pumped.
   */
  async stopTurnLoop(): Promise<void> {
    this.unsubscribeTurnWake?.();
    this.unsubscribeTurnWake = null;
    if (this.turnRunner) {
      await this.turnRunner.stop();
      this.turnRunner = null;
    }
  }

  /**
   * (Re-)subscribe the turn loop's auto-wake to the CURRENT session manager.
   * Called from startTurnLoop and from build() so a reset() (which rebuilds
   * the manager) cannot leave the wake bound to a stale instance.
   */
  private rewireTurnWake(): void {
    this.unsubscribeTurnWake?.();
    this.unsubscribeTurnWake = null;
    if (!this.turnRunner || !this.sessionManager) return;

    this.unsubscribeTurnWake = this.sessionManager.onNotification((notification) => {
      this.turnRunner?.submit({
        content: formatSubSessionReport(notification),
        source: "subsession",
        preferMidTurn: true,
        coalesceKey: "subsession-report",
      });
    });
  }

  /**
   * Persist the current session state. Called automatically by dispatchAsync,
   * reset, and compact — expose as public so callers can flush ad-hoc changes.
   */
  async finalize(): Promise<void> {
    this.session.updatedAt = Date.now();
    // Backstop flush: rounds flush as they complete, but a turn that threw
    // between rounds may still hold an unpersisted tail.
    await this.conversation.flush();
    await this.store.save(this.session);
  }

  /**
   * Clear the conversation transcript and re-read the workspace context from
   * disk, picking up any edits to agentcontext.md since last load.
   *
   * Reset means ABANDON: in-flight work is stopped (current turn, queued
   * turns, sub-sessions) and awaited down to quiescence first — clearing
   * while a turn unwinds would let the dying turn write into the fresh
   * conversation.
   */
  async reset(): Promise<boolean> {
    this.stopAllWork();
    await this.turnRunner?.awaitIdle();
    if (this.session.status === "running") {
      // Backstop for hosts that dispatch directly (no turn loop): we hold no
      // abort handle for such a turn, so refusing is the only safe option.
      throw new Error(`Session "${this.session.sessionId}" is running a turn; cannot reset now.`);
    }

    // Reset is a SOFT delete: the transcript is flushed, marked deleted
    // (deletedAt stamped, file kept as <id>.deleted.json for audit), and the
    // session relinks to a fresh conversation — the old file is never
    // appended to again. build() below opens the new transcript.
    await this.conversation.flush();
    await this.conversation.markDeleted();
    this.session.conversationId = randomUUID();
    this.session.status = "idle";
    this.session.counters.turns = 0;
    this.workspace = await this.workspaces.reload(this.session.workspaceId);
    this.session.updatedAt = Date.now();
    await this.store.save(this.session);
    await this.build();

    return true;
  }

  /**
   * Fold the entire conversation into a single summary checkpoint. Unlike the
   * orchestrator's automatic threshold-gated summarization, this collapses the
   * whole transcript — no verbatim tail is kept.
   *
   * Like reset, compacting implies stopping: the transcript must be quiescent
   * while the summarizer reads it, so in-flight work is cancelled and awaited
   * down rather than raced or refused.
   */
  async compact(options: { signal?: AbortSignal } = {}): Promise<CompactResult> {
    this.stopAllWork();
    await this.turnRunner?.awaitIdle();
    if (this.session.status === "running") {
      // Backstop for direct-dispatch hosts — no abort handle, so refuse.
      throw new Error(`Session "${this.session.sessionId}" is running a turn; cannot compact now.`);
    }

    const messages = this.conversation.getMessages();
    if (messages.length === 0 || (messages.length === 1 && isSummaryMessage(messages[0]))) {
      return { summarizedCount: 0, skipped: true, summary: null };
    }

    const summarizer = new Summarizer(this);
    const summaryText = await summarizer.summarize([...messages], { signal: options.signal });
    const summarizedCount = messages.length;

    await this.conversation.replaceAll([buildSummaryMessage(summaryText, summarizedCount)]);
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

  getConversation(): Conversation {
    return this.conversation;
  }

  getWorkspace(): Workspace {
    return this.workspace;
  }

  history(): readonly ChatMessage[] {
    return this.conversation.getMessages();
  }

  getContextLoader(): ContextLoader {
    return this.contextLoader;
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

/**
 * Shape a settled child's notification into the round content the parent's
 * orchestrator receives. Self-describing: the orchestrator's system prompt
 * knows nothing about sub-session reports, so the message itself carries the
 * facts AND what to do with them.
 */
function formatSubSessionReport(notification: SubSessionNotification): string {
  const header =
    notification.status === "done"
      ? `[sub-session report] Sub-session ${notification.subSessionId} COMPLETED.`
      : `[sub-session report] Sub-session ${notification.subSessionId} FAILED.`;

  const body =
    notification.status === "done"
      ? `Result:\n${notification.result ?? "(no result text)"}`
      : `Error:\n${notification.error ?? "(no error detail)"}`;

  return [
    header,
    `Intent: ${notification.intent}`,
    body,
    "",
    "This report arrived asynchronously from a sub-session you previously spawned. " +
      "Reconcile it with the original request it served: if follow-up work is needed, do it now; " +
      "otherwise reply with a brief confirmation of the outcome for the user.",
  ].join("\n");
}
