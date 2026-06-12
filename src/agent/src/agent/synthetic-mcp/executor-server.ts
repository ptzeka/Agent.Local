import { randomUUID } from "node:crypto";

import type { Mcp, ToolExecutionResult } from "../mcp/mcp.js";
import type { ToolDescriptor } from "../providers/provider.js";
import type { RuntimeContext } from "../runtime/types.js";
import type { OrchestratorListener } from "../runners/runner-events.js";
import { OrchestratorEventTypes } from "../runners/runner-events.js";
import { DispatchTracker, dispatchSignature, type DispatchAsk } from "./dispatch-tracker.js";
import type { TurnBindable } from "./types.js";
import { buildSubRuntime } from "../runtime/build-sub-runtime.js";

/**
 * ExecutorLocalMcp — in-process MCP server that exposes a single tool:
 * `executor__dispatch`. Each dispatch builds a BRAND-NEW child runtime from
 * scratch with role "executor" — its own session (parent-linked), context
 * snapshot, registries, and persistence. Nothing is shared with the parent
 * runtime besides the workspace, so dispatches cannot pollute each other or
 * the parent; an executor child is ephemeral, sized to one tool-call-shaped
 * ask, and its persisted session is the future resume point for the sub-task.
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

    // Brand-new child runtime per dispatch: own session (parent-linked, fresh
    // id), own registries and context snapshot, persisted by its own store.
    // Deliberately built from scratch — no parent state leaks in, no dispatch
    // sees another's transcript; a failed ask is simply dispatched again.
    const parentSession = this.ctx.session!;
    const childRuntime = buildSubRuntime(
      {
        configPath: this.ctx.configPath,
        orchestratorRole: "executor",
        sessionsDir: this.ctx.sessionsDir,
        workspaceRoot: this.ctx.workspaceRoot,
        sandboxRoot: this.ctx.sandboxRoot,
        mcpConfigPath: this.ctx.mcpConfigPath,
        credentials: this.ctx.credentials,
      },
      {
        sessionId: randomUUID(),
        parentSessionId: parentSession.sessionId,
        workspaceId: parentSession.workspaceId,
        user: parentSession.user,
      }
    );

    const emit = this.turnEmit;
    let content: string;
    let ok: boolean;
    let iterations = 0;
    let usage: ToolExecutionResult["usage"];
    let runtime: Awaited<ReturnType<typeof childRuntime.build>> | undefined;

    try {
      runtime = await childRuntime.build();
      const result = await runtime.dispatchAsync(askMessage, {
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

    // The child accumulated its own model usage while running; expose it on
    // the tool result so the parent folds the delegated cost into its tally.
    // A failed dispatch still burned tokens, so this sits outside the try.
    if (runtime) usage = { ...runtime.getSession().counters };

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

    return { isError: !ok, content, usage };
  }
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
