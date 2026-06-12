import type { ExecutorAsk, ExecutorFeedback } from "../runners/zzz_executor.js";
import type { ToolExecutionResult } from "../mcp/mcp-client.js";
import type { ToolDescriptor } from "../providers/provider.js";
import { dispatchSignature } from "./dispatch-tracker.js";
import { toolError, toolOk, type SyntheticMcp, type SyntheticMcpContext } from "./types.js";
import { buildRuntime } from "../runtime/build-runtime.js";
import { AgentRuntimeDeps } from "../runtime/types.js";
import { run } from "node:test";

export const DISPATCH_TOOL_NAME = "dispatch_executor";

/**
 * `dispatch_executor` — the synthetic tool that spawns the EXECUTOR sub-agent to
 * perform exactly one mutation. This is the ONLY way the orchestrator can change
 * state; write/edit/shell tools are never advertised to it directly.
 *
 * The tool is constructed from the executor's allowed tool list so its `enum`
 * stays in lockstep with what the executor can actually run. At call time it
 * reserves a dispatch slot, validates and de-duplicates the ask, runs the
 * executor, and formats the structured feedback (ACK + RESULT + deterministic
 * verdict) back to the orchestrator's LLM.
 */
export class DispatchExecutorTool implements SyntheticMcp {
  public readonly name = DISPATCH_TOOL_NAME;
  public readonly descriptor: ToolDescriptor;

  constructor(private readonly executorTools: ToolDescriptor[]) {
    this.descriptor = buildDispatchToolDescriptor(executorTools);
  }

  public async callTool(
    args: Record<string, unknown>,
    ctx: SyntheticMcpContext
  ): Promise<ToolExecutionResult> {
    // Reserve a slot first; a refused reservation means the cap is spent.
    const reservation = ctx.tracker.reserve();
    if (!reservation.ok) {
      ctx.emit({ type: "warning", data: { message: "dispatch cap reached", reason: reservation.reason } });
      return toolError(`[dispatch-blocked] ${reservation.reason}`);
    }

    const ask = parseDispatchAsk(args, this.executorTools);
    if (!ask.ok) {
      ctx.emit({ type: "warning", data: { message: ask.reason } });
      return toolError(`[dispatch-error] ${ask.reason}`);
    }

    // Duplicate guard. If this exact mutation already landed this turn,
    // re-running it makes no progress — steer instead of dispatching again.
    const signature = dispatchSignature(ask.value);
    if (ctx.tracker.isDuplicate(signature)) {
      ctx.emit({
        type: "warning",
        data: { message: "duplicate dispatch blocked by validator", tool: ask.value.tool },
      });
      return toolError(
        `EVALUATOR: STOP — duplicate dispatch. You already ran this exact ` +
          `mutation (tool=${ask.value.tool}) successfully this turn; repeating ` +
          `it changes nothing. Re-read the request and the current workspace ` +
          `state, then take a DIFFERENT next action — or, if the task is done, ` +
          `produce a final answer with NO tool calls.`
      );
    }

    ctx.emit({
      type: "dispatch-start",
      data: { tool: ask.value.tool, intent: ask.value.intent, args: ask.value.args },
    });

    const  deps = {
      configPath: ctx.configPath,
      orchestratorRole: "executor",
      sessionsDir: ctx.sessionsDir,
      workspaceRoot: ctx.workspace.workspaceId,
      sandboxRoot: ctx.sandboxRoot,
      mcpConfigPath: ctx.mcpConfigPath,
      credentials: ctx.credentials
    } as AgentRuntimeDeps;
    var runtime = await buildRuntime(deps, ctx.session.sessionId).build();
    const feedback = await runtime.dispatchAsync(args["intent"], {
      onEvent: (event: any) =>
        ctx.emit({ type: "executor-event", data: { ...event.data, kind: event.type } }),
    });

    if (ctx.signal)
    {
      ctx.signal.onabort(e => runtime.stopAllWork());
    }

    ctx.emit({
      type: "dispatch-feedback",
      data: {
        ok: feedback.ok,
        ack: feedback.ack,
        evidence: feedback.evidence,
        deterministicVerdict: feedback.deterministicVerdict,
        iterations: feedback.iterations,
      },
    });

    // Only a genuinely-successful mutation counts as progress.
    if (feedback.ok) {
      ctx.tracker.recordSuccess(signature);
    }

    const content = formatFeedbackForOrchestrator(feedback);
    return feedback.ok ? toolOk(content) : toolError(content);
  }
}

// ---------------------------------------------------------------------------

function buildDispatchToolDescriptor(executorTools: ToolDescriptor[]): ToolDescriptor {
  const executorToolNames = executorTools.map((t) => t.name).sort();  
  const description = [
    "Spawn the EXECUTOR sub-agent to perform exactly one mutation.",
    "This is the ONLY way the orchestrator can change state — write_file,",
    "edit_file, and shell tools are NOT directly callable.",
    "",
    `Allowed values for "tool" (executor-side tool names):`,
    ...executorToolNames.map((n) => `  - ${n}`),
    "",
    "The executor will ACK the ask, run the tool, independently re-read or",
    "check the result, and return a structured feedback message that includes",
    "both its own RESULT line and a deterministic verdict computed in code.",
  ].join("\n");

  return {
    name: DISPATCH_TOOL_NAME,
    description,
    inputSchema: {
      type: "object",
      required: ["tool", "args", "intent"],
      properties: {
        tool: {
          type: "string",
          description: "Executor-side tool name (must be one of the names listed above).",
          enum: executorToolNames,
        },
        args: {
          oneOf: executorTools.map((tool) => ({
            title: tool.name,
            ...tool.inputSchema,
          })),
        },
        intent: {
          type: "string",
          description: "One-line plain-English description of what this dispatch accomplishes.",
        },
      },
    },
  };
}

function parseDispatchAsk(
  rawArgs: Record<string, unknown>,
  executorTools: ToolDescriptor[]
): { ok: true; value: ExecutorAsk } | { ok: false; reason: string } {
  const tool = rawArgs.tool;
  const args = rawArgs.args;
  const intent = rawArgs.intent;

  if (typeof tool !== "string" || tool.length === 0) {
    return { ok: false, reason: "dispatch_executor.tool must be a non-empty string" };
  }
  if (typeof intent !== "string" || intent.length === 0) {
    return { ok: false, reason: "dispatch_executor.intent must be a non-empty string" };
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, reason: "dispatch_executor.args must be an object" };
  }

  const allowed = new Set(executorTools.map((t) => t.name));
  if (!allowed.has(tool)) {
    return {
      ok: false,
      reason: `dispatch_executor.tool "${tool}" is not in the executor's allowed tool set`,
    };
  }

  return {
    ok: true,
    value: {
      tool,
      args: args as Record<string, unknown>,
      intent,
    },
  };
}

function formatFeedbackForOrchestrator(feedback: ExecutorFeedback): string {
  const lines: string[] = [];
  lines.push(`EXECUTOR: ACK ${feedback.ack ?? "(missing — protocol violation)"}`);
  if (feedback.llmReport) {
    lines.push(feedback.llmReport.trim());
  } else {
    lines.push("EXECUTOR: RESULT (no RESULT line emitted by executor)");
  }
  lines.push(
    `EXECUTOR: DETERMINISTIC ${feedback.deterministicVerdict.toUpperCase()} — ${feedback.evidence}`
  );
  lines.push(`EXECUTOR: FINAL ${feedback.ok ? "OK" : "FAIL"}`);
  return lines.join("\n");
}
