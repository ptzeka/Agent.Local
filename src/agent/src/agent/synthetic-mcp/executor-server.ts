import { randomUUID } from "node:crypto";

import type { ToolExecutionResult } from "../mcp/mcp.js";
import { LocalMcp } from "../mcp/local-mcp.js";
import type { ToolDescriptor } from "../providers/provider.js";
import type { McpClientRegistry } from "../registries/index.js";
import type { RuntimeContext } from "../runtime/types.js";
import { OrchestratorEventTypes } from "../runners/runner-events.js";
import { DispatchTracker, dispatchSignature, type DispatchAsk } from "./dispatch-tracker.js";
import type { TurnBindable } from "./types.js";
import { buildSubRuntime } from "../runtime/build-sub-runtime.js";
import { CancellationToken } from "../../common/lifetime.js";
import { Eventing } from "../../common/eventing.js";

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


export class ExecutorLocalMcp extends LocalMcp implements TurnBindable {
  // Promise-chain mutex: each dispatch chains after the previous one settles.
  private runLock: Promise<void> = Promise.resolve();

  // Bootstrap cutoff for the Mcp contract: shutdown() cancels it, killing every
  // child this server dispatched — independent of any turn's signal.
  private readonly scope = new CancellationToken();

  // Per-turn context — set by the orchestrator before each user turn.
  private turnSignal: AbortSignal | undefined = undefined;
  private turnTracker: DispatchTracker | undefined = undefined;
  // The turn's MCP bus: we PUBLISH up it instead of calling an emit callback.
  // Defaulted so an unbound turn (the executor sub-run never binds) is a no-op.
  private turnEvents: Eventing = new Eventing();

  constructor(
    private readonly ctx: RuntimeContext,
    // Advertisement-only registry of the EXECUTOR role's servers. Distinct from
    // ctx.mcpRegistry (the owning role's mounts): the executor's write tools
    // must NOT be enumerable through the parent's scoped client, only here.
    private readonly executorServers: McpClientRegistry
  ) {
    // Handlers close over `this`, so tools register after super(). Registered
    // descriptors are routing keys only — listTools() advertises live ones.
    super(EXECUTOR_SERVER_NAME, []);
    this.registerTool({
      descriptor: buildDispatchDescriptor([]),
      invoke: (args) => this.dispatch(args),
    });
    // Read-only introspection — answered in-process, never spawns an executor.
    this.registerTool({
      descriptor: LIST_TOOLS_DESCRIPTOR,
      invoke: async () => ({
        isError: false,
        content: JSON.stringify(this.resolveExecutorTools(), null, 2),
      }),
    });
  }

  /**
   * Called by the orchestrator at the start of every turn that may dispatch.
   * Binds the current abort signal, event bus, and dispatch tracker so the
   * executor sub-run shares them without needing them in the tool args.
   */
  public bindTurn(
    signal: AbortSignal | undefined,
    tracker: DispatchTracker,
    events: Eventing
  ): void {
    this.turnSignal = signal;
    this.turnTracker = tracker;
    this.turnEvents = events;
  }

  /**
   * Overrides the base's static advertisement: the dispatch descriptor embeds
   * the executor's LIVE tool enum, so it must be rebuilt on every call.
   */
  public override listTools(): ToolDescriptor[] {
    return [
      buildDispatchDescriptor(this.resolveExecutorTools().map((tool) => tool.name)),
      LIST_TOOLS_DESCRIPTOR,
    ].map((descriptor) => ({ ...descriptor, name: `${this.name}__${descriptor.name}` }));
  }

  /**
   * Full descriptors of the tools the executor role may run. The advertisement
   * registry already holds exactly the executor role's mounted servers (built
   * from its models.json `mcp` list), so declared-but-unmounted servers — e.g.
   * `codemcp` — are simply absent. The executor server itself is never mounted
   * into that registry, so a dispatch can never target dispatch.
   */
  private resolveExecutorTools(): ToolDescriptor[] {
    return this.executorServers.listTools();
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
        this.turnEvents.publish(OrchestratorEventTypes.WARNING, { message: reservation.reason });
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

  // The Mcp contract's kill path: dispatches run under scope OR turn signal,
  // so this reaches in-flight children even when no turn abort fires.
  public override async shutdown(): Promise<void> {
    this.scope.cancel("executor-server-shutdown");
  }

  /** Signal handed to dispatched children: the server scope OR the turn. */
  private dispatchSignal(): AbortSignal {
    return this.turnSignal
      ? AbortSignal.any([this.turnSignal, this.scope.signal])
      : this.scope.signal;
  }

  // ---------------------------------------------------------------------------

  private async runDispatch(
    tool: string,
    toolArgs: Record<string, unknown>,
    intent: string,
    tracker: DispatchTracker | undefined
  ): Promise<ToolExecutionResult> {
    const signal = this.dispatchSignal();
    // Construct the canonical ask message the executor Orchestrator will receive.
    const askMessage =
      `Tool: ${tool}\n` +
      `Args: ${JSON.stringify(toolArgs, null, 2)}\n` +
      `Intent: ${intent}`;

    // Publish up the MCP bus instead of an emit callback: this bubbles
    // mcpClientEvents → turnEvents → runtime → host (CLI).
    this.turnEvents.publish(OrchestratorEventTypes.DISPATCH_START, { tool, intent, args: toolArgs });

    // Brand-new child runtime per dispatch: own session (parent-linked, fresh
    // id), own registries and context snapshot, persisted by its own store.
    // Deliberately built from scratch — no parent state leaks in, no dispatch
    // sees another's transcript; a failed ask is simply dispatched again.
    const parentSession = this.ctx.session!;
    const childRuntime = buildSubRuntime(
      {
        logger: this.ctx.logger,
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
        // Chained under the turn's signal OR the server scope: a turn abort and
        // an Mcp shutdown() both kill the child's run and resources.
        parentSignal: signal,
      }
    );

    let content: string;
    let ok: boolean;
    let iterations = 0;
    let usage: ToolExecutionResult["usage"];
    let runtime: Awaited<ReturnType<typeof childRuntime.build>> | undefined;

    try {
      runtime = await childRuntime.build();
      // The child is its own event root; bridge its turn events up as
      // `executor-event` so the renderer tags them as the sub-run's, not the
      // parent's. This is the MCP-bus link the parent reaches the child through.
      const detach = runtime.getEvents().subscribe((event) =>
        this.turnEvents.publish(OrchestratorEventTypes.EXECUTOR_EVENT, {
          ...event.payload,
          kind: event.type,
        })
      );
      try {
        const result = await runtime.dispatchAsync(askMessage, { signal });
        content = result.finalMessage.content;
        ok = result.outcome === "satisfied";
        iterations = result.iterations;
      } finally {
        detach();
      }
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

    this.turnEvents.publish(OrchestratorEventTypes.DISPATCH_FEEDBACK, {
      ok,
      ack: extractFirstLine(content, "EXECUTOR: ACK"),
      evidence: extractFirstLine(content, "EXECUTOR: RESULT"),
      deterministicVerdict: "unverified",
      iterations,
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

export const EXECUTOR_ROLE = "executor" as const;

// Server mount name — same string as the role, but a distinct concept.
export const EXECUTOR_SERVER_NAME = "executor";

// Read-only safety net beside the dispatch enum: when the orchestrator is
// unsure of a target tool's exact name or argument shape, it can fetch the
// full descriptors (name, description, inputSchema) instead of guessing.
const LIST_TOOLS_DESCRIPTOR: ToolDescriptor = {
  name: "list_tools",
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
    name: "dispatch",
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
