import { randomUUID } from "node:crypto";

import type { Mcp, ToolExecutionResult } from "../mcp/mcp.js";
import type { ToolDescriptor } from "../providers/provider.js";
import type { AgentRuntimeQueryable, RuntimeContext } from "../runtime/types.js";
import type { Session } from "../session/session.js";
import type { OrchestratorListener } from "../runners/runner-events.js";
import { OrchestratorEventTypes } from "../runners/runner-events.js";
import { Orchestrator } from "../runners/orchestrator.js";
import { DispatchTracker, dispatchSignature, type DispatchAsk } from "./dispatch-tracker.js";
import type { TurnBindable } from "./types.js";

/**
 * ExecutorLocalMcp — in-process MCP server that exposes a single tool:
 * `executor__dispatch`. The orchestrator calls this instead of the old
 * hybrid intercept; internally it runs a full `Orchestrator` sub-loop with
 * role "executor", giving the executor its own model, tools, and system prompt.
 *
 * Constructed ONCE at middleware startup with a `RuntimeContext` reference.
 * All context fields are resolved lazily at call time (the ctx object is fully
 * populated by the time any tool call arrives). Per-turn state (signal, emit,
 * tracker) is injected by the orchestrator via `bindTurn` before each turn.
 *
 * Only one executor dispatch can run at a time: a promise-chain mutex ensures
 * sequential execution without blocking the caller's microtask queue.
 */
export class ExecutorLocalMcp implements Mcp, TurnBindable {
  public readonly name = "executor";

  // Promise-chain mutex: each dispatch chains after the previous one settles.
  private runLock: Promise<void> = Promise.resolve();

  // Per-turn context — set by the orchestrator before each user turn.
  private turnSignal: AbortSignal | undefined = undefined;
  private turnEmit: OrchestratorListener = () => {};
  private turnTracker: DispatchTracker | undefined = undefined;

  constructor(private readonly ctx: RuntimeContext) {}

  /**
   * Called by the orchestrator at the start of every turn that may dispatch.
   * Binds the current abort signal, event emitter, and dispatch tracker so
   * the executor sub-run shares them without needing them in the tool args.
   */
  public bindTurn(
    signal: AbortSignal | undefined,
    emit: OrchestratorListener,
    tracker: DispatchTracker
  ): void {
    this.turnSignal = signal;
    this.turnEmit = emit;
    this.turnTracker = tracker;
  }

  public listTools(): ToolDescriptor[] {
    return [DISPATCH_DESCRIPTOR];
  }

  public async callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    if (toolName !== "dispatch") {
      return { isError: true, content: `Unknown tool "${toolName}" on executor server.` };
    }

    const tool = String(args.tool ?? "");
    const toolArgs = (typeof args.args === "object" && args.args !== null && !Array.isArray(args.args)
      ? args.args
      : {}) as Record<string, unknown>;
    const intent = String(args.intent ?? "");

    if (!tool) return { isError: true, content: "[dispatch-error] tool is required" };
    if (!intent) return { isError: true, content: "[dispatch-error] intent is required" };

    // Cap and duplicate guard run BEFORE entering the mutex so we fail fast
    // without queuing behind a running dispatch.
    const tracker = this.turnTracker;
    if (tracker) {
      const reservation = tracker.reserve();
      if (!reservation.ok) {
        this.turnEmit({ type: "warning", data: { message: reservation.reason } });
        return { isError: true, content: `[dispatch-blocked] ${reservation.reason}` };
      }

      const ask: DispatchAsk = { tool, args: toolArgs, intent };
      if (tracker.isDuplicate(dispatchSignature(ask))) {
        return {
          isError: true,
          content:
            "EVALUATOR: STOP — duplicate dispatch. You already ran this exact mutation " +
            "successfully this turn; repeating it changes nothing. Re-read the request " +
            "and workspace state, then take a DIFFERENT next action — or produce a final " +
            "answer with NO tool calls.",
        };
      }
    }

    // Mutex: chain this dispatch after any currently-running one.
    const prev = this.runLock;
    let resolve!: () => void;
    this.runLock = new Promise((r) => (resolve = r));
    try {
      await prev;
      return await this.runDispatch(tool, toolArgs, intent, tracker);
    } finally {
      resolve();
    }
  }

  public async shutdown(): Promise<void> {}

  // ---------------------------------------------------------------------------

  private async runDispatch(
    tool: string,
    toolArgs: Record<string, unknown>,
    intent: string,
    tracker: DispatchTracker | undefined
  ): Promise<ToolExecutionResult> {
    // Construct the canonical ask message the executor Orchestrator will receive.
    const askMessage =
      `Tool: ${tool}\n` +
      `Args: ${JSON.stringify(toolArgs, null, 2)}\n` +
      `Intent: ${intent}`;

    this.turnEmit({
      type: OrchestratorEventTypes.DISPATCH_START,
      data: { tool, intent, args: toolArgs },
    });

    // Ephemeral session: fresh conversation in the same workspace, not persisted.
    const parentSession = this.ctx.session!;
    const ephemeralSession: Session = {
      sessionId: `${parentSession.sessionId}-exec-${randomUUID().slice(0, 8)}`,
      workspaceId: parentSession.workspaceId,
      conversation: [],
      status: "running",
      counters: {
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const runtimeView = new EphemeralRuntimeView(this.ctx, ephemeralSession);
    const executorOrch = new Orchestrator("executor");
    executorOrch.setRuntime(runtimeView);

    const emit = this.turnEmit;
    let content: string;
    let ok: boolean;
    let iterations = 0;

    try {
      const result = await executorOrch.run(askMessage, {
        signal: this.turnSignal,
        // Forward executor sub-run events so the REPL can render them.
        onEvent: (event) =>
          emit({ type: "executor-event", data: { ...event.data, kind: event.type } }),
      });
      content = result.finalMessage.content;
      ok = result.outcome === "satisfied";
      iterations = result.iterations;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      content = `[executor-error] ${msg}`;
      ok = false;
    }

    if (tracker && ok) {
      tracker.recordSuccess(dispatchSignature({ tool, args: toolArgs, intent }));
    }

    emit({
      type: OrchestratorEventTypes.DISPATCH_FEEDBACK,
      data: {
        ok,
        ack: extractFirstLine(content, "EXECUTOR: ACK"),
        evidence: extractFirstLine(content, "EXECUTOR: RESULT"),
        deterministicVerdict: "unverified",
        iterations,
      },
    });

    return { isError: !ok, content };
  }
}

// ---------------------------------------------------------------------------
// EphemeralRuntimeView — wraps a RuntimeContext but swaps in an ephemeral
// session so the executor sub-run has a clean transcript. All other facets
// (providers, models, MCP registry, workspace) come from the shared context.
// ---------------------------------------------------------------------------

class EphemeralRuntimeView implements AgentRuntimeQueryable {
  constructor(
    private readonly ctx: RuntimeContext,
    private readonly session: Session
  ) {}

  getSession() { return this.session; }
  getWorkspace() { return this.ctx.workspace!; }
  getModelsRegistry() { return this.ctx.modelsRegistry!; }
  getConfigurationRegistry() { return this.ctx.configurationRegistry!; }
  getProvidersRegistry() { return this.ctx.providerRegistry!; }
  getMcpClientRegistry() { return this.ctx.mcpRegistry!; }
  getContextLoader() { return this.ctx.contextLoader!; }
  getLogger() { return this.ctx.logger!; }
}

// ---------------------------------------------------------------------------
// Static tool descriptor for executor__dispatch. No dynamic enum for "tool"
// — the executor model's system prompt names valid tools; a strict enum would
// require listing all namespaced tool names which changes with server mounts.
// ---------------------------------------------------------------------------

const DISPATCH_DESCRIPTOR: ToolDescriptor = {
  name: "executor__dispatch",
  description: [
    "Spawn the EXECUTOR sub-agent to perform exactly one mutation.",
    "This is the ONLY way the orchestrator can change state — write_file,",
    "edit_file, and shell tools are NOT directly callable by the orchestrator.",
    "",
    'Provide "tool" as the fully-namespaced executor-side tool name',
    '(e.g. "fsmcp__write_file"). "args" is the exact argument object for',
    'that tool. "intent" is a one-line plain-English description of what',
    "this dispatch accomplishes; the executor uses it to interpret the action.",
    "",
    "The executor will ACK the ask, run the tool, independently re-read or",
    "check the result, and return a RESULT line with evidence.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    required: ["tool", "args", "intent"],
    properties: {
      tool: {
        type: "string",
        description:
          "Fully-namespaced executor-side tool name (e.g. fsmcp__write_file, codemcp__edit_file).",
      },
      args: {
        type: "object",
        description: "Exact argument object for the named tool.",
      },
      intent: {
        type: "string",
        description: "One-line plain-English description of what this dispatch accomplishes.",
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Parse helpers — the executor emits structured lines; we pull the key bits
// for the dispatch-feedback event without requiring a full regex suite.
// ---------------------------------------------------------------------------

function extractFirstLine(content: string, prefix: string): string {
  const line = content.split("\n").find((l) => l.startsWith(prefix));
  return line ?? "";
}
