import { randomUUID } from "node:crypto";

import type { ToolExecutionResult } from "@agent-local/mcp";
import { LocalMcp } from "@agent-local/mcp";
import { CancellationToken } from "@agent-local/common/lifetime";
import type { RoleDispatch } from "../registries/configuration-registry.js";
import type { RuntimeContext } from "../runtime/types.js";
import { SessionToken } from "../runtime/tokens.js";
import { buildSubRuntime } from "../runtime/build-sub-runtime.js";
import { parseDispatchResult, validateShape } from "../runners/policies/dispatch-result.js";

// generic dispatch-as-a-tool: runs a dispatchable role as a fresh child and validates its answer against
// the role's declared `returns`. The MCP call IS the contract gate — inputSchema gates the payload, `returns`
// gates the response — so any caller (a model tool-call or the loop's epilogue) gets the same guarantees.
// role-agnostic: give it a role + its dispatch record; the executor stays a specialised cousin (tool-enum grounding).
export class RoleDispatchLocalMcp extends LocalMcp {
  // bootstrap cutoff so shutdown() kills any in-flight child independent of a caller's signal
  private readonly scope = new CancellationToken();

  constructor(
    private readonly ctx: RuntimeContext,
    private readonly role: string,
    private readonly dispatch: RoleDispatch,
    serverName: string,
    private readonly toolName: string
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
      },
      invoke: (args, cutoffscope) => this.run(args, cutoffscope.signal),
    });
  }

  public override async shutdown(): Promise<void> {
    this.scope.cancel("role-dispatch-shutdown");
  }

  // builds a scratch child for the role, runs the one ask, then GATES the answer on the declared `returns`:
  // JSON is the contract, defaults fill a flaky answer, and a shape violation surfaces as isError
  private async run(args: Record<string, unknown>, callSignal: AbortSignal): Promise<ToolExecutionResult> {
    const ask = String(args.ask ?? "");
    if (!ask) return { isError: true, content: "[dispatch-error] ask is required" };

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

    let content = "";
    let ok = false;
    let usage: ToolExecutionResult["usage"];
    let runtime: Awaited<ReturnType<typeof child.build>> | undefined;
    try {
      runtime = await child.build();
      const result = await runtime.dispatchAsync(ask, { signal });
      content = result.finalMessage.content;
      ok = result.outcome === "satisfied";
    } catch (err) {
      content = `[dispatch-error] ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      if (runtime) {
        // fold the child's token spend up so the parent's tally stays whole even on a failed run
        usage = { ...runtime.metricsTotals(), sessionId: runtime.getSession().sessionId };
        await runtime.finalize().catch(() => undefined);
      }
    }

    // the response gate: normalise to the declared shape, then flag any violation as an error result
    const returns = this.dispatch.returns;
    const record = parseDispatchResult(content, returns);
    const violations = returns ? validateShape(record, returns) : [];
    return { isError: !ok || violations.length > 0, content: JSON.stringify(record), usage };
  }
}
