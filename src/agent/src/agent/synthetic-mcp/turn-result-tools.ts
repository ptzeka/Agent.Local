import type { ToolDescriptor } from "@agent-local/mcp/tooldescriptor";
import {
  toolError,
  toolOk,
  type ReportedTurnResult,
  type RichToolResult,
  type SyntheticMcp,
  type ToolContext,
  type TurnResultSink,
} from "./types.js";

export const REPORT_RESULT_TOOL = "report_result";

// turn-scoped holder the orchestrator mints per dispatched turn and reads after the round to terminate.
// last-write-wins so a model that re-reports overwrites cleanly rather than the loop banking a stale verdict.
export class TurnResultCapture implements TurnResultSink {
  private reported?: ReportedTurnResult;

  // first-wins: a round's tool calls run concurrently, so two report_result calls could both land here
  set(reported: ReportedTurnResult): void {
    if (this.reported) return;
    this.reported = reported;
  }

  get value(): ReportedTurnResult | undefined {
    return this.reported;
  }
}

// the agent's mandated terminal action on a dispatched turn: it hands back a structured verdict the workflow
// gates on, instead of leaving the answer buried in free-text prose (M5-9). status is the parseable channel
// distinct from the loop's outcome; result is whatever structured payload the asked task calls for.
export function createReportResultTools(): SyntheticMcp[] {
  return [
    {
      name: REPORT_RESULT_TOOL,
      descriptor: reportResultDescriptor(),
      callTool: handleReportResult,
    },
  ];
}

async function handleReportResult(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<RichToolResult> {
  // no sink means this turn isn't dispatched (interactive); the tool shouldn't be advertised there, but guard anyway
  if (!ctx.resultSink) {
    return toolError("[report_result-error] structured results are not available in this run");
  }

  const status = args.status;
  if (status !== "success" && status !== "fail") {
    return toolError('[report_result-error] status must be exactly "success" or "fail"');
  }

  // result is free-form structured data the asked task defines; default to an empty object so the envelope is always shaped
  const result = "result" in args ? args.result : {};

  ctx.resultSink.set({ status, result });

  return toolOk(`result recorded (status=${status})`);
}

function reportResultDescriptor(): ToolDescriptor {
  return {
    name: REPORT_RESULT_TOOL,
    description: [
      "Finish the turn by reporting the final, structured result of the task.",
      "You MUST call this exactly once as your LAST action — do not answer in prose.",
      "",
      'status: "success" if the asked task/condition holds, "fail" if it does not.',
      "For a verify/assert task, status reflects the ANSWER (e.g. the row is missing",
      '=> "fail"), NOT merely whether you completed the check.',
      "result: a JSON object capturing the structured outcome (the values found, the",
      "assertion detail, ids created, etc.) so the caller can act on it without parsing prose.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      required: ["status", "result"],
      properties: {
        status: {
          type: "string",
          enum: ["success", "fail"],
          description: 'Whether the asked task/condition holds ("success") or not ("fail").',
        },
        result: {
          type: "object",
          description: "Structured outcome payload for the caller (shape is task-defined).",
        },
      },
    },
  };
}
