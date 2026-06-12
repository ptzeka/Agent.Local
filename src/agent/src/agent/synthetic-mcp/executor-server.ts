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
 * A tool hosted on the executor server. Same shape as LocalMcp's LocalTool,
 * except the descriptor is produced by a function: the dispatch descriptor
 * embeds the executor's LIVE tool enum, so it cannot be a static object.
 */
interface ExecutorTool {
  /** Bare name — `callTool` receives it with the server prefix stripped. */
  name: string;
  describe(): ToolDescriptor;
  invoke(args: Record<string, unknown>): Promise<ToolExecutionResult>;
}

/**
 * ExecutorLocalMcp — in-process MCP server for executor coordination:
 * `executor__dispatch` (run one mutation) and `executor__list_tools`
 * (introspect what dispatch can target). Each dispatch builds a BRAND-NEW
 * child runtime from scratch with role "executor" — its own session
 * (parent-linked), context snapshot, registries, and persistence. Nothing is
 * shared with the parent runtime besides the workspace, so dispatches cannot
 * pollute each other or the parent; an executor child is ephemeral, sized to
 * one tool-call-shaped ask, and its persisted session is the future resume
 * point for the sub-task.
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

  private readonly toolsByName: Map<string, ExecutorTool>;

  // Promise-chain mutex: each dispatch chains after the previous one settles.
  private runLock: Promise<void> = Promise.resolve();

  // Per-turn context — set by the orchestrator before each user turn.
  private turnSignal: AbortSignal | undefined = undefined;
  private turnEmit: OrchestratorListener = () => {};
  private turnTracker: DispatchTracker | undefined = undefined;

  constructor(private readonly ctx: RuntimeContext) {
    const tools: ExecutorTool[] = [
      {
        name: "dispatch",
        describe: () =>
          buildDispatchDescriptor(this.resolveExecutorTools().map((tool) => tool.name)),
        invoke: (args) => this.dispatch(args),
      },
      {
        // Read-only introspection — answered in-process, never spawns an executor.
        name: "list_tools",
        describe: () => LIST_TOOLS_DESCRIPTOR,
        invoke: async () => ({
          isError: false,
          content: JSON.stringify(this.resolveExecutorTools(), null, 2),
        }),
      },
    ];
    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  }

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
    return [...this.toolsByName.values()].map((tool) => tool.describe());
  }

  /**
   * Full descriptors of the tools the executor role may run, resolved fresh on
   * every advertisement (role → model → models.json `mcp` list) so they track
   * live server mounts: declared-but-unmounted servers drop out, exactly like
   * the orchestrator's own server resolution.
   */
  private resolveExecutorTools(): ToolDescriptor[] {
    const modelsRegistry = this.ctx.modelsRegistry;
    const mcpRegistry = this.ctx.mcpRegistry;
    if (!modelsRegistry || !mcpRegistry) return [];
    return modelsRegistry
      .getValidMcpForModel(EXECUTOR_ROLE)
      // A dispatch must never target dispatch itself.
      .filter((serverName) => serverName !== this.name)
      .flatMap((serverName) => mcpRegistry.getClient(serverName)?.listTools() ?? []);
  }

  public async callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    const executorTool = this.toolsByName.get(toolName);
    if (!executorTool) {
      return { isError: true, content: `Unknown tool "${toolName}" on executor server.` };
    }
    return executorTool.invoke(args);
  }

  private async dispatch(args: Record<string, unknown>): Promise<ToolExecutionResult> {
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
        orchestratorRole: EXECUTOR_ROLE,
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
// Dispatch descriptor builder. The "tool" property carries a strict enum of
// the executor-side tool names AND repeats them in the description: the enum
// rejects invented names at the schema level, the prose list keeps the names
// visible to models that ignore enums (prompted-JSON fallbacks). Built per
// listTools() call so it tracks live server mounts.
// ---------------------------------------------------------------------------

const EXECUTOR_ROLE = "executor" as const;

// Read-only safety net beside the dispatch enum: when the orchestrator is
// unsure of a target tool's exact name or argument shape, it can fetch the
// full descriptors (name, description, inputSchema) instead of guessing.
const LIST_TOOLS_DESCRIPTOR: ToolDescriptor = {
  name: "executor__list_tools",
  description:
    "List the tools the EXECUTOR can run via executor__dispatch, as full JSON " +
    "descriptors (name, description, inputSchema). Read-only and instant — call " +
    "it whenever you are unsure of a dispatch target's exact name or argument " +
    "shape instead of guessing.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

function buildDispatchDescriptor(executorToolNames: string[]): ToolDescriptor {
  const toolListBlock =
    executorToolNames.length > 0
      ? 'Valid "tool" values (the ONLY accepted names):\n' +
        executorToolNames.map((name) => `  - ${name}`).join("\n")
      : "No executor-side tools are currently mounted; any dispatch will fail.";

  return {
    name: "executor__dispatch",
    description: [
      "Spawn the EXECUTOR sub-agent to perform exactly one mutation.",
      "This is the ONLY way the orchestrator can change state — write_file,",
      "edit_file, and shell tools are NOT directly callable by the orchestrator.",
      "",
      'Provide "tool" as the fully-namespaced executor-side tool name.',
      '"args" is the exact argument object for that tool. "intent" is a',
      "one-line plain-English description of what this dispatch accomplishes;",
      "the executor uses it to interpret the action.",
      "",
      toolListBlock,
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
          // Omit an empty enum rather than emit an unsatisfiable schema.
          ...(executorToolNames.length > 0 ? { enum: executorToolNames } : {}),
          description:
            "Fully-namespaced executor-side tool name. Must be one of the names " +
            "enumerated in this tool's description.",
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
}

// ---------------------------------------------------------------------------
// Parse helpers — the executor emits structured lines; we pull the key bits
// for the dispatch-feedback event without requiring a full regex suite.
// ---------------------------------------------------------------------------

function extractFirstLine(content: string, prefix: string): string {
  const line = content.split("\n").find((l) => l.startsWith(prefix));
  return line ?? "";
}
