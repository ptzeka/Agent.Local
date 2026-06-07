import { randomUUID } from "node:crypto";

import type { McpToolClient } from "./mcp-client.js";
import type { ModelRegistry } from "./model-registry.js";
import { Orchestrator, type RunOptions, type RunResult } from "./orchestrator.js";
import type { ProjectContext } from "./context-loader.js";
import type { ChatMessage } from "./providers/provider.js";
import { createSession, type Session } from "./session.js";
import { SessionStore } from "./session-store.js";
import { Summarizer, buildSummaryMessage, isSummaryMessage } from "./summarizer.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

/**
 * Initializer.
 *
 * The single stateful component and the agent's logical entry point. It:
 *   - owns the live `Map<sessionId, Session>` and persists sessions
 *   - resolves a session by `sessionId` for every incoming action
 *   - drives the (stateless) orchestrator: hand it the session + workspace,
 *     run a turn, then update lifecycle and persist at the turn boundary
 *   - is the natural place to later spawn a second session + orchestrator
 *     run for a background task (seam reserved below)
 *
 * Everything below it is stateless: the orchestrator, executor, evaluator,
 * summarizer and providers all receive their state as arguments and hold
 * nothing between calls.
 */

export interface InitializerDeps {
  registry: ModelRegistry;
  tools: McpToolClient;
  sessionStore: SessionStore;
  workspaces: WorkspaceRegistry;
}

export interface OpenSessionParams {
  /** Filesystem root used to resolve this workspace's project context. */
  workspaceRoot: string;
  /**
   * Join an existing workspace by id to share its context with sibling
   * sessions. Omit to mint an isolated workspace for this session.
   */
  workspaceId?: string;
  /** Reserved for sub-sessions; unused until background agents land. */
  parentSessionId?: string;
}

export interface ResetResult {
  /** The context now in effect after the reload (null if no file present). */
  context: ProjectContext | null;
  /** True if the reloaded context differs from what was loaded before. */
  contextChanged: boolean;
}

export interface CompactResult {
  /** Number of messages folded into the summary (0 when skipped). */
  summarizedCount: number;
  /** True when there was nothing worth compacting (empty / already a summary). */
  skipped: boolean;
  /** The condensed summary text produced, or null when skipped. */
  summary: string | null;
}

export class Initializer {
  private readonly sessions = new Map<string, Session>();
  private readonly orchestrator: Orchestrator;

  constructor(private readonly deps: InitializerDeps) {
    // One stateless orchestrator serves every session.
    this.orchestrator = new Orchestrator(deps.registry, deps.tools);
  }

  /**
   * Convenience composition root: build the file-backed session store and
   * an empty workspace registry, then return a ready Initializer. Callers
   * supply the already-bootstrapped shared infrastructure (registry, tools).
   */
  public static create(params: {
    registry: ModelRegistry;
    tools: McpToolClient;
    sessionsDir: string;
  }): Initializer {
    return new Initializer({
      registry: params.registry,
      tools: params.tools,
      sessionStore: SessionStore.create(params.sessionsDir),
      workspaces: new WorkspaceRegistry(),
    });
  }

  /**
   * Open a fresh session. Mints ids, registers (or joins) its workspace,
   * tracks it in memory, and persists the initial record so it is
   * resumable from the very first turn.
   */
  public async openSession(params: OpenSessionParams): Promise<Session> {
    const workspaceId = params.workspaceId ?? randomUUID();
    await this.deps.workspaces.register(workspaceId, params.workspaceRoot);

    const session = createSession({
      sessionId: randomUUID(),
      workspaceId,
      parentSessionId: params.parentSessionId,
    });

    this.sessions.set(session.sessionId, session);
    await this.deps.sessionStore.save(session);
    return session;
  }

  /**
   * Run one user turn against a session. Owns the lifecycle around the
   * stateless orchestrator: the running-guard, status transitions, the turn
   * counter, and turn-boundary persistence (in `finally`, so a thrown turn
   * still records its partial transcript and `error` status).
   */
  public async dispatch(
    sessionId: string,
    userInput: string,
    options: RunOptions = {}
  ): Promise<RunResult> {
    const session = this.requireSession(sessionId);
    if (session.status === "running") {
      throw new Error(`Session "${sessionId}" is already running a turn.`);
    }

    const workspace = this.deps.workspaces.get(session.workspaceId);
    session.status = "running";

    try {
      const result = await this.orchestrator.run(session, workspace, userInput, options);
      session.status = "awaiting-input";
      session.counters.turns += 1;
      return result;
    } catch (err) {
      session.status = "error";
      throw err;
    } finally {
      session.updatedAt = Date.now();
      await this.deps.sessionStore.save(session);
    }
  }

  /**
   * Reset a session to its start: clear the transcript and re-read the
   * workspace context from disk (picking up edits to agentcontext.md). A clean
   * slate — to keep a summarized checkpoint instead, use `compact`.
   */
  public async reset(sessionId: string): Promise<ResetResult> {
    const session = this.requireSession(sessionId);

    const before = this.deps.workspaces.get(session.workspaceId).projectContext?.content ?? null;
    const workspace = await this.deps.workspaces.reload(session.workspaceId);
    const after = workspace.projectContext?.content ?? null;

    session.conversation.length = 0;
    session.status = "idle";
    session.counters.turns = 0;
    session.updatedAt = Date.now();
    await this.deps.sessionStore.save(session);

    return { context: workspace.projectContext, contextChanged: before !== after };
  }

  /**
   * Compact a session on demand: fold the ENTIRE conversation into a single
   * summary checkpoint and continue from it (reset + summarize). Unlike the
   * orchestrator's automatic, threshold-gated summarization, this keeps no
   * verbatim tail — the whole transcript collapses to one summary message. The
   * summary marks its work as already done (see buildSummaryMessage), so the
   * session resumes without re-executing anything.
   *
   * A no-op when there's nothing worth folding (empty, or already a lone
   * summary), and refused while a turn is in flight to avoid racing the
   * orchestrator's in-place mutation of the same conversation.
   */
  public async compact(
    sessionId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<CompactResult> {
    const session = this.requireSession(sessionId);
    if (session.status === "running") {
      throw new Error(`Session "${sessionId}" is running a turn; cannot compact now.`);
    }

    const messages = session.conversation;
    if (messages.length === 0 || (messages.length === 1 && isSummaryMessage(messages[0]))) {
      return { summarizedCount: 0, skipped: true, summary: null };
    }

    const summarizer = new Summarizer(this.deps.registry.getSummarizerProvider());
    const summaryText = await summarizer.summarize(messages, { signal: options.signal });
    const summarizedCount = messages.length;

    session.conversation.length = 0;
    session.conversation.push(buildSummaryMessage(summaryText, summarizedCount));
    session.updatedAt = Date.now();
    await this.deps.sessionStore.save(session);

    return { summarizedCount, skipped: false, summary: summaryText };
  }

  public history(sessionId: string): readonly ChatMessage[] {
    return this.requireSession(sessionId).conversation;
  }

  public getSession(sessionId: string): Session {
    return this.requireSession(sessionId);
  }

  /** Project context for a session's workspace (for banners/diagnostics). */
  public getWorkspaceContext(sessionId: string): ProjectContext | null {
    const session = this.requireSession(sessionId);
    return this.deps.workspaces.get(session.workspaceId).projectContext;
  }

  /**
   * Spawn a detached session + orchestrator run for a background task.
   * Seam reserved for the background-agent work; intentionally unimplemented
   * so the shape is visible without committing to scheduling/sub-session
   * semantics yet.
   */
  public async spawnBackground(): Promise<never> {
    throw new Error("spawnBackground: background agents are not implemented yet (TBD).");
  }

  private requireSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown sessionId "${sessionId}".`);
    }
    return session;
  }
}
