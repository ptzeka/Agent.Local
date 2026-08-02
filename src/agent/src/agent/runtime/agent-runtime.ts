import { randomUUID } from "node:crypto";
import type { Conversation } from "../conversation/conversation.js";
import { InputInbox } from "../runners/input-inbox.js";
import { TurnLoop, type RunResult } from "../runners/turn-loop.js";
import {
  composeRunnerPipeline,
  type IRunnerMiddleware,
  type RunnerContext,
} from "../runners/middleware/runner-middleware.js";
import type { ContextLoader } from "../context/context-loader.js";
import type { ChatMessage } from "../providers/provider.js";
import type { Session, UsageTotals } from "../session/session.js";
import { SessionStore, type SessionSummary } from "../session/session-store.js";
import { Summarizer, buildSummaryMessage, isSummaryMessage } from "../runners/summarizer.js";
import { TurnRunner, type TurnRunnerListener, type TurnSource } from "../runners/turn-runner.js";
import type { Workspace } from "../registries/workspace-registry.js";
import { WorkspaceRegistry } from "../registries/workspace-registry.js";
import type { AgentRuntimeDeps, AgentRuntimeQueryable, IMiddleware, RuntimeContext } from "./types.js";
import type { ModelRegistry } from "../registries/model-registry.js";
import type { McpClientRegistry } from "../registries/mcp-registry.js";
import { CancellationToken, settledWithin } from "@agent-local/common/lifetime";
import { Eventing } from "@agent-local/common/eventing";
import { ConfigurationRegistry } from "../registries/configuration-registry.js";
import { ProvidersRegistry } from "../registries/providers-registry.js";
import { ILogger } from "@agent-local/common/ilogger";
import {
  ConfigurationToken,
  ContextLoaderToken,
  ConversationToken,
  InboxToken,
  McpRegistryToken,
  MetricsRegistryToken,
  ModelsToken,
  TurnLoopToken,
  ProvidersToken,
  RunnerMiddlewareToken,
  SessionToken,
  StoreToken,
  WorkspaceToken,
  WorkspacesToken,
} from "./tokens.js";
import type { Container } from "@agent-local/common/container";
import type { DatabaseHandle } from "@agent-local/common/db";

export interface ResetResult {
  projectContext: string | null;
  contextChanged: boolean;
}

export interface CompactResult {
  summarizedCount: number;
  skipped: boolean;
  summary: string | null;
}

// stateful owner of a single session: a fluent middleware pipeline runs once in build() to
// assemble every subsystem, then this exposes the per-session operations (dispatch/reset/compact)
export class AgentRuntime implements AgentRuntimeQueryable {
  private readonly middlewares: IMiddleware[] = [];

  // populated by build() — all required after construction
  private logger!: ILogger;
  private session!: Session;
  private conversation!: Conversation;
  private workspace!: Workspace;
  private modelsRegistry!: ModelRegistry;
  private configurationRegistry!: ConfigurationRegistry;
  private providersRegistry!: ProvidersRegistry;
  private mcpClientRegistry!: McpClientRegistry;
  private contextLoader!: ContextLoader;
  private turnLoop!: TurnLoop;
  private inbox!: InputInbox;
  private store!: SessionStore;
  private workspaces!: WorkspaceRegistry;
  // held so the per-turn RunnerContext can resolve runtime services on demand
  private container!: Container;
  // folded around each turn's run; empty group ≡ bare core, so the seam stays behaviour-neutral
  private runnerMiddlewares: IRunnerMiddleware[] = [];

  // optional: hosts opt in via startTurnLoop; headless single runs call dispatchAsync directly
  private turnRunner: TurnRunner | null = null;

  // parent cutoff for every turn, agent child, and MCP client this runtime owns
  private readonly scope: CancellationToken;
  // created ONCE for the runtime's lifetime: a rebuild must not re-mint it or it strands host subscriptions
  private readonly events: Eventing = new Eventing();
  // first shutdown() wins; later callers join its promise
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly deps: AgentRuntimeDeps) {
    // constructor body, not field initializer: must not race `deps` assignment
    this.scope = new CancellationToken(deps.parentSignal);
  }

  // --------------------------------------------------------------------------
  // Fluent builder
  // --------------------------------------------------------------------------

  add(middleware: IMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  // constructs nothing itself: every subsystem is produced by a middleware step
  // must be awaited before any other method
  async build(): Promise<this> {
    // registry is created by ContainerMiddleware (first step); RuntimeContext is assignable to this seed, so the cast is sound
    const ctx = {
      config: this.deps.config,
      sessionsDir: this.deps.sessionsDir,
      db: this.deps.db,
      workspaceRoot: this.deps.workspaceRoot,
      sandboxRoot: this.deps.sandboxRoot,
      credentials: this.deps.credentials ?? {},
      logger: this.deps.logger,
      runtimeSignal: this.scope.signal,
      // seed the lifetime-stable bus so a rebuild chains under the host rather than orphaning subscribers
      eventing: this.events,
    } as RuntimeContext;

    await this.runPipeline(ctx, 0);

    // events is lifetime-owned (see the field), so it is not re-claimed here
    // each get() throws naming its token, so a misordered/incomplete pipeline fails loudly at the gap
    this.logger = ctx.logger;
    this.configurationRegistry = ctx.registry.get(ConfigurationToken);
    this.modelsRegistry = ctx.registry.get(ModelsToken);
    this.mcpClientRegistry = ctx.registry.get(McpRegistryToken);
    this.contextLoader = ctx.registry.get(ContextLoaderToken);
    this.providersRegistry = ctx.registry.get(ProvidersToken);
    this.store = ctx.registry.get(StoreToken);
    this.workspaces = ctx.registry.get(WorkspacesToken);
    this.session = ctx.registry.get(SessionToken);
    this.conversation = ctx.registry.get(ConversationToken);
    this.workspace = ctx.registry.get(WorkspaceToken);
    this.turnLoop = ctx.registry.get(TurnLoopToken);
    this.inbox = ctx.registry.get(InboxToken);
    this.container = ctx.registry;
    this.runnerMiddlewares = ctx.registry.getAll(RunnerMiddlewareToken);

    // reset() rebuilds the inbox, so re-bind the wake or it points at the dead one
    this.rewireInboxWake();

    this.logger.debug("runtime initialized", { sessionId: this.session.sessionId });
    return this;
  }

  // --------------------------------------------------------------------------
  // Per-turn operations
  // --------------------------------------------------------------------------

  // the single per-turn bundle: DI handle + this turn's state + glue; every runner reads off this
  // turn bus chained under the runtime's so turn events bubble up to the host without an onEvent callback
  private beginTurn(options: { signal: AbortSignal }): RunnerContext {
    const events = new Eventing();
    this.events.add(events);
    // wrap, never replace: a unit cancelling this cuts the turn and everything below it, never the caller's signal
    const cutoff = new CancellationToken(options.signal);
    return {
      session: this.session,
      events,
      signal: cutoff.signal,
      cutoff,
      logger: this.logger,
      registry: this.container,
      runtime: this,
      hasPending: () => this.inbox.hasPending(this.session.sessionId),
      pullInjectedPrompt: () => this.inbox.dequeue(this.session.sessionId),
      executedRecord: (item) => this.inbox.executedRecord(this.session.sessionId, item),
      recordExecuted: (item, record) =>
        this.inbox.recordExecuted(this.session.sessionId, item, record),
    };
  }

  // finalize() runs in finally so every exit path (clean, capped, thrown) persists the session
  async dispatchAsync(input: string, options: { signal: AbortSignal }): Promise<RunResult> {
    if (this.session.status === "running") {
      throw new Error(`Session "${this.session.sessionId}" is already running a turn.`);
    }

    // seed the opening prompt through the inbox so even a direct dispatch has no separate first-message path
    if (input !== undefined && input.trim().length > 0) {
      this.inbox.push(this.session.sessionId, input);
    }

    this.session.status = "running";
    this.events.publish("runtime-status", { sessionId: this.session.sessionId, status: "running" });
    this.logger.debug("runtime running", { sessionId: this.session.sessionId });
    this.logger.debug("turn start", { sessionId: this.session.sessionId });

    // the turn-loop run is the pipeline core; registered units fold around it as an onion
    const ctx = this.beginTurn(options);
    const runTurn = composeRunnerPipeline(this.runnerMiddlewares, ctx, () =>
      this.turnLoop.run(ctx)
    );

    try {
      const result = await runTurn();
      // awaiting-input is healthy (ready for the next message), same as satisfied — only capped/failed are error
      this.session.status =
        result.outcome === "satisfied" || result.outcome === "awaiting-input" ? "awaiting-input" : "error";
      this.session.counters.turns += 1;
      this.events.publish("runtime-status", {
        sessionId: this.session.sessionId,
        status: this.session.status,
        outcome: result.outcome,
      });
      return result;
    } catch (err) {
      // a user stop is abandonment, not failure: come back ready for input, not flagged broken
      this.session.status = options.signal?.aborted ? "awaiting-input" : "error";
      throw err;
    } finally {
      this.logger.debug("turn end", { sessionId: this.session.sessionId, status: this.session.status });
      await this.finalize();
    }
  }

  // queued and drained as the next turn, so safe whether or not a turn is in flight
  // idempotencyKey lets a producer that can retry (an HTTP caller) name the request itself instead of
  // relying on a content hash; false means the push was absorbed as a duplicate
  injectInput(content: string, source?: string, idempotencyKey?: string): boolean {
    return this.inbox.push(this.session.sessionId, content, source, idempotencyKey);
  }

  // --------------------------------------------------------------------------
  // Turn loop — multi-producer scheduling over dispatchAsync
  // --------------------------------------------------------------------------

  // start main loop
  startTurnLoop(options: { onTurnEvent?: TurnRunnerListener } = {}): TurnRunner {
    if (this.turnRunner) return this.turnRunner;

    this.turnRunner = new TurnRunner(
      async (signal) => {
        // contentless: the dispatch drains the inbox itself for this turn's input
        const result = await this.dispatchAsync('', { signal });
        return { outcome: result.outcome };
      },
      {
        onEvent: options.onTurnEvent,
        // chained under the scope so a runtime cancel reaches turns without enumeration
        parentSignal: this.scope.signal,
        // run only when the inbox holds input, so a wake the running turn already drained doesn't run empty
        shouldRun: () => this.inbox.hasPending(this.session.sessionId),
      }
    );

    this.rewireInboxWake();
    this.turnRunner.start();
    return this.turnRunner;
  }

  // stop all work, trigger signal cascade abort. A cancelled turn takes its in-flight agent children with
  // it: they run inside its tool calls and share its signal
  stopAllWork(): { cancelledTurns: number } {
    const cancelledTurns = this.turnRunner?.cancelAll() ?? 0;
    // one prompt per turn leaves later prompts queued mid-run: drop them so stop truly stops
    this.inbox.clear(this.session.sessionId);
    return { cancelledTurns };
  }

  // complete current work and stop
  async stopTurnLoop(): Promise<void> {
    if (this.turnRunner) {
      await this.turnRunner.stop();
      this.turnRunner = null;
    }
  }

  // terminate
  async shutdown(options: { mode: "drain" | "abort"; timeoutMs?: number }): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.runShutdown(options);
    }
    return this.shutdownPromise;
  }

  private async runShutdown(options: { mode: "drain" | "abort"; timeoutMs?: number }): Promise<void> {
    const timeoutMs = options.timeoutMs ?? (options.mode === "abort" ? 5_000 : 30_000);

    const quiescence = (): Promise<void> =>
      this.turnRunner?.awaitIdle() ?? Promise.resolve();

    if (options.mode === "abort") {
      this.stopAllWork();
      this.scope.cancel("shutdown");
      await settledWithin(quiescence(), timeoutMs);
    } else {
      const drained = await settledWithin(quiescence(), timeoutMs);
      if (!drained) {
        this.stopAllWork();
        this.scope.cancel("shutdown-timeout");
        await settledWithin(quiescence(), 5_000);
      }
    }

    if (this.turnRunner) {
      await this.turnRunner.stop();
      this.turnRunner = null;
    }

    // cancel even after a clean drain to release token-holding resources (MCP clients)
    this.scope.cancel("shutdown");
    await this.finalize();
  }

  // called from startTurnLoop and build() so a reset() (which rebuilds the inbox) can't leave the wake stale
  private rewireInboxWake(): void {
    if (!this.turnRunner) return;
    this.inbox.setOnPush((source) => this.turnRunner?.wake(source as TurnSource | undefined));
  }

  // public so callers can flush ad-hoc changes; dispatchAsync/reset/compact call it automatically
  async finalize(): Promise<void> {
    this.session.updatedAt = Date.now();
    // backstop: rounds flush as they complete, but a turn that threw between rounds may hold a tail
    await this.conversation.flush();
    await this.store.save(this.session);
  }

  // reset means ABANDON: in-flight work is stopped and awaited to quiescence first, or a dying
  // turn would write into the fresh conversation; also re-reads agentcontext.md edits since last load
  async reset(): Promise<boolean> {
    this.stopAllWork();
    await this.turnRunner?.awaitIdle();
    if (this.session.status === "running") {
      // direct-dispatch hosts give no abort handle for the turn, so refusing is the only safe option
      throw new Error(`Session "${this.session.sessionId}" is running a turn; cannot reset now.`);
    }

    // SOFT delete: the old transcript is kept as <id>.deleted.json for audit; build() opens a fresh one
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

  // collapses the WHOLE transcript (no verbatim tail), unlike the orchestrator's threshold-gated pass
  // stops in-flight work first so the summarizer reads a quiescent transcript, never a racing one
  async compact(options: { signal?: AbortSignal } = {}): Promise<CompactResult> {
    this.stopAllWork();
    await this.turnRunner?.awaitIdle();
    if (this.session.status === "running") {
      // direct-dispatch hosts give no abort handle, so refuse
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

  getTurnLoop(): TurnLoop {
    return this.turnLoop;
  }

  getLogger(): ILogger {
    return this.logger;
  }

  // host subscribes here, or chains it under its own bus
  getEvents(): Eventing {
    return this.events;
  }

  isStreamOutputEnabled(): boolean {
    return this.deps.streamOutput ?? false;
  }

  // the container-owned token tally (own + delegated subtree); read across the ChildRuntime boundary so a
  // parent can fold a settled child's spend without depending on the runtime-layer MetricsRegistry type
  metricsTotals(): Readonly<UsageTotals> {
    return this.container.get(MetricsRegistryToken).totals();
  }

  // --------------------------------------------------------------------------
  // Static utilities (pre-session)
  // --------------------------------------------------------------------------

  // static so the picker can call it before any runtime is built (before a session is chosen); userId is
  // required so every listing is owner-scoped — logged-out callers pass the anonymous sub, never the whole table
  static listSavedSessions(db: DatabaseHandle, userId: string): Promise<SessionSummary[]> {
    return SessionStore.create(db).summaries(userId);
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

