import { randomUUID } from "node:crypto";

import type { ToolExecutionResult } from "@agent-local/mcp";
import { LocalMcp } from "@agent-local/mcp";
import type { ToolDescriptor } from "@agent-local/mcp/tooldescriptor";
import type { McpClientRegistry } from "../registries/index.js";
import type { RuntimeContext } from "../runtime/types.js";
import { SessionToken } from "../runtime/tokens.js";
import { OrchestratorEventTypes } from "../runners/runner-events.js";
import { DispatchTracker, dispatchSignature, type DispatchAsk } from "./dispatch-tracker.js";
import type { TurnBindable } from "./types.js";
import { buildSubRuntime } from "../runtime/build-sub-runtime.js";
import { CancellationToken } from "@agent-local/common/lifetime";
import { Eventing } from "@agent-local/common/eventing";

// in-process server for executor__dispatch (run one mutation) and executor__list_tools (introspect targets)
// each dispatch builds a brand-new role-"executor" child from scratch, sharing only the workspace, so dispatches can't pollute each other
// constructed ONCE; per-turn state (signal, events, tracker) is injected via bindTurn before each turn
// a promise-chain mutex serialises dispatches without blocking the caller's microtask queue
export class ExecutorLocalMcp extends LocalMcp implements TurnBindable {
  // each dispatch chains after the previous one settles
  private runLock: Promise<void> = Promise.resolve();

  // bootstrap cutoff for the Mcp contract: shutdown() cancels it, killing every child, independent of any turn
  private readonly scope = new CancellationToken();

  private turnSignal: AbortSignal | undefined = undefined;
  private turnTracker: DispatchTracker | undefined = undefined;
  // PUBLISH up this bus instead of an emit callback; defaulted so an unbound turn (the executor sub-run) is a no-op
  private turnEvents: Eventing = new Eventing();

  constructor(
    private readonly ctx: RuntimeContext,
    // separate from ctx.mcpRegistry so the executor's write tools are enumerable only here, never via the parent's scoped client
    private readonly executorServers: McpClientRegistry
  ) {
    // handlers close over `this`, so tools register after super(); these descriptors are routing keys, listTools() advertises live ones
    super(EXECUTOR_SERVER_NAME, []);
    this.registerTool({
      descriptor: buildDispatchDescriptor([]),
      invoke: (args) => this.dispatch(args),
    });
    // read-only introspection, answered in-process; never spawns an executor
    this.registerTool({
      descriptor: LIST_TOOLS_DESCRIPTOR,
      invoke: async () => ({
        isError: false,
        content: JSON.stringify(this.resolveExecutorTools(), null, 2),
      }),
    });
  }

  // binds signal/tracker/events so the executor sub-run shares them without carrying them in tool args
  public bindTurn(
    signal: AbortSignal | undefined,
    tracker: DispatchTracker,
    events: Eventing
  ): void {
    this.turnSignal = signal;
    this.turnTracker = tracker;
    this.turnEvents = events;
  }

  // rebuilt every call because the dispatch descriptor embeds the executor's LIVE tool enum
  public override listTools(): ToolDescriptor[] {
    return [
      buildDispatchDescriptor(this.resolveExecutorTools().map((tool) => tool.name)),
      LIST_TOOLS_DESCRIPTOR,
    ].map((descriptor) => ({ ...descriptor, name: `${this.name}__${descriptor.name}` }));
  }

  // sourced from the advertisement registry, which holds only the executor role's mounted servers,
  // so declared-but-unmounted servers are absent and a dispatch can never target dispatch itself
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

    // cap and duplicate guard run BEFORE the mutex so we fail fast without queuing behind a running dispatch
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

    // chain this dispatch after any currently-running one
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

  // dispatches run under scope OR turn signal, so this reaches in-flight children even when no turn abort fires
  public override async shutdown(): Promise<void> {
    this.scope.cancel("executor-server-shutdown");
  }

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
    const askMessage =
      `Tool: ${tool}\n` +
      `Args: ${JSON.stringify(toolArgs, null, 2)}\n` +
      `Intent: ${intent}`;

    this.turnEvents.publish(OrchestratorEventTypes.DISPATCH_START, { tool, intent, args: toolArgs });

    // built from scratch so no parent state leaks in and no dispatch sees another's transcript
    const parentSession = this.ctx.registry.get(SessionToken);
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
        // a turn abort and an Mcp shutdown() both kill the child's run and resources through this signal
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
      // bridge the child's events up as `executor-event` so the renderer tags them as the sub-run's, not the parent's
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

    // exposed on the result so the parent folds the delegated cost; outside the try since a failed dispatch still burned tokens
    // sourced from the child's MetricsRegistry (own + tallied subtree) now that token spend lives there, not on the session
    if (runtime) usage = { ...runtime.metricsTotals(), sessionId: runtime.getSession().sessionId };

    if (tracker && ok) {
      tracker.recordSuccess(dispatchSignature({ tool, args: toolArgs, intent }));
    }

    this.turnEvents.publish(OrchestratorEventTypes.DISPATCH_FEEDBACK, {
      // `ok` reflects only whether the executor sub-run completed, not whether the mutation
      // succeeded — the orchestrator judges that from the verbal report
      ok,
      ack: extractFirstLine(content, "EXECUTOR: ACK"),
      // executor reports verbally now; its concluding line stands in as the evidence snippet
      evidence: lastNonEmptyLine(content),
      iterations,
    });

    return { isError: !ok, content, usage };
  }
}

export const EXECUTOR_ROLE = "executor" as const;

// same string as the role, but a distinct concept
export const EXECUTOR_SERVER_NAME = "executor";

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

// the enum rejects invented names at the schema level; the prose list repeats them for models that ignore enums
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
      "This is the ONLY way the orchestrator can change state e.g. write_file,",
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
      "check the result, and report what it observed, with evidence. The",
      "report is a factual account, not a verdict — you judge whether it landed.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      required: ["tool", "args", "intent"],
      properties: {
        tool: {
          type: "string",
          // omit an empty enum rather than emit an unsatisfiable schema
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

// pulls one structured line the executor emits, for the dispatch-feedback event, without a full regex suite
function extractFirstLine(content: string, prefix: string): string {
  const line = content.split("\n").find((l) => l.startsWith(prefix));
  return line ?? "";
}

// the executor's verbal report has no fixed status line, so its concluding sentence is the evidence snippet
function lastNonEmptyLine(content: string): string {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}
