import { randomUUID } from "node:crypto";

import type { ToolExecutionResult } from "@agent-local/mcp";
import { LocalMcp } from "@agent-local/mcp";
import { CancellationToken } from "@agent-local/common/lifetime";
import { Eventing } from "@agent-local/common/eventing";
import type { RoleDispatch } from "../registries/configuration-registry.js";
import type { RuntimeContext } from "../runtime/types.js";
import { SessionToken } from "../runtime/tokens.js";
import { buildSubRuntime } from "../runtime/build-sub-runtime.js";
import { OrchestratorEventTypes } from "../runners/runner-events.js";
import type { DispatchTracker } from "./dispatch-tracker.js";
import type { TurnBindable, TurnBinding } from "./types.js";

// every role-agent advertises the same verb; the role's own `description` carries what it is for
export const DISPATCH_TOOL = "ask" as const;

// dispatch-as-a-tool: runs a dispatchable role as a fresh child and validates its answer against the role's
// declared `returns`. The MCP call IS the contract gate — inputSchema gates the payload, `returns` gates the
// response — so any caller (a model tool-call or the loop's epilogue) gets the same guarantees.
// role-agnostic by construction: give it a role plus that role's dispatch record and it serves any agent
export class RoleDispatchLocalMcp extends LocalMcp implements TurnBindable {
  // bootstrap cutoff so shutdown() kills any in-flight child independent of a caller's signal
  private readonly scope = new CancellationToken();

  private turnTracker: DispatchTracker | undefined = undefined;
  // defaulted so an unbound turn (this agent's own child run) publishes into the void rather than throwing
  private turnEvents: Eventing = new Eventing();

  constructor(
    private readonly ctx: RuntimeContext,
    private readonly role: string,
    private readonly dispatch: RoleDispatch,
    serverName: string,
    toolName: string
  ) {
    // handler closes over `this`, so register after super()
    super(serverName, []);
    this.registerTool({
      descriptor: {
        name: toolName,
        description: dispatch.description,
        inputSchema: {
          type: "object",
          required: ["ask"],
          properties: {
            ask: { type: "string", description: "The full instruction / question for the sub-agent." },
          },
        },
        // the role's declared `returns` IS the contract; LocalMcp.callTool gates the answer against it
        outputSchema: dispatch.returns,
      },
      invoke: (args, cutoffscope) => this.admit(args, cutoffscope.signal),
    });
  }

  // takes the turn's tracker and bus; absent (a leaf's own run) the agent still works, just unaccounted
  public bindTurn(binding: TurnBinding): void {
    this.turnTracker = binding.tracker;
    this.turnEvents = binding.events ?? new Eventing();
  }

  public override async shutdown(): Promise<void> {
    this.scope.cancel("role-dispatch-shutdown");
  }

  // ---------------------------------------------------------------------------

  // the cap is checked before any child is built, so a coordinator stuck in a loop is refused cheaply
  private async admit(args: Record<string, unknown>, callSignal: AbortSignal): Promise<ToolExecutionResult> {
    const ask = String(args.ask ?? "");
    if (!ask) return { isError: true, content: "[dispatch-error] ask is required" };

    const tracker = this.turnTracker;
    const reservation = tracker?.reserve(this.role, this.dispatch.cap);
    if (reservation && !reservation.ok) {
      this.turnEvents.publish(OrchestratorEventTypes.WARNING, { message: reservation.reason });
      return { isError: true, content: `[dispatch-blocked] ${reservation.reason}` };
    }

    const result = await this.run(ask, callSignal);
    tracker?.settle(!result.isError);
    return result;
  }

  // builds a scratch child for the role and runs the one ask; the answer's shape is NOT checked here —
  // the descriptor's outputSchema makes that the client's job, so every server is gated the same way
  private async run(ask: string, callSignal: AbortSignal): Promise<ToolExecutionResult> {
    const signal = AbortSignal.any([callSignal, this.scope.signal]);
    const parent = this.ctx.registry.get(SessionToken);
    const child = buildSubRuntime(
      {
        logger: this.ctx.logger,
        config: this.ctx.config,
        orchestratorRole: this.role,
        sessionsDir: this.ctx.sessionsDir,
        db: this.ctx.db,
        workspaceRoot: this.ctx.workspaceRoot,
        sandboxRoot: this.ctx.sandboxRoot,
        credentials: this.ctx.credentials,
      },
      {
        sessionId: randomUUID(),
        parentSessionId: parent.sessionId,
        workspaceId: parent.workspaceId,
        user: parent.user,
        parentSignal: signal,
      }
    );

    this.turnEvents.publish(OrchestratorEventTypes.DISPATCH_START, { role: this.role, ask });

    let content = "";
    let ok = false;
    let iterations = 0;
    let usage: ToolExecutionResult["usage"];
    let runtime: Awaited<ReturnType<typeof child.build>> | undefined;
    try {
      runtime = await child.build();
      const detach = this.bridgeUp(runtime.getEvents());
      try {
        const result = await runtime.dispatchAsync(ask, { signal });
        content = result.finalMessage.content;
        ok = result.outcome === "satisfied";
        iterations = result.iterations;
      } finally {
        detach();
      }
    } catch (err) {
      content = `[dispatch-error] ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      if (runtime) {
        // fold the child's token spend up so the parent's tally stays whole even on a failed run
        usage = { ...runtime.metricsTotals(), sessionId: runtime.getSession().sessionId };
        await runtime.finalize().catch(() => undefined);
      }
    }

    this.turnEvents.publish(OrchestratorEventTypes.DISPATCH_FEEDBACK, {
      // `ok` reflects only whether the child's run settled, not whether its answer is right —
      // the caller judges that from the report
      ok,
      role: this.role,
      evidence: lastNonEmptyLine(content),
      iterations,
    });

    // the shape gate runs one layer up, in the client
    return { isError: !ok, content, usage };
  }

  // republished under one type so a renderer can tag the whole subtree as a sub-run without knowing the role
  private bridgeUp(childEvents: Eventing): () => void {
    return childEvents.subscribe((event) =>
      this.turnEvents.publish(OrchestratorEventTypes.AGENT_EVENT, {
        ...event.payload,
        kind: event.type,
        role: this.role,
      })
    );
  }
}

// an agent's report has no fixed status line, so its concluding sentence stands in as the evidence snippet
function lastNonEmptyLine(content: string): string {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}
