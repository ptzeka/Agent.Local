import type { Mcp } from "@agent-local/mcp";
import type { ChatMessage } from "../providers/provider.js";
import type { AgentRuntimeQueryable } from "../runtime/types.js";
import { stampReport } from "./policies/dispatch-result.js";
import { OrchestratorEventTypes } from "./runner-events.js";

// the terminal evaluator pass: call the evaluator dispatch tool (a registry client), which runs the judge
// as a fresh sub-agent and GATES its answer on the role's `returns`. All the judge's LLM work lives in that
// tool; what remains here is only WHAT to evaluate (the judge input), the fail-open safety, and the stamp-back.

// the config role whose record backs the judge; a lookup key, not a code branch (cf. EXECUTOR_ROLE)
export const EVALUATOR_ROLE = "evaluator" as const;
// the dispatch client mounted for coordinator roles, and its one tool — the loop calls this directly
export const EVALUATOR_SERVER_NAME = "evaluator" as const;
export const EVALUATE_TOOL = "evaluate" as const;

// the states the judge can return; the CLI colours them and a headless job can act on them
export type EvaluationState = "pass" | "fail" | "incomplete";

export interface EvaluatorPassInput {
  question: string;
  // the coordinator's tool-free message proposed as the final answer
  proposedAnswer: string;
  transcript: ChatMessage[];
}

// runs the judge and returns the structured verdict. fails OPEN (skip / dispatch error → pass) so a flaky
// judge can never trap the caller; the verdict is stamped into the conversation via the role's report template
export async function runEvaluatorPass(
  runtime: AgentRuntimeQueryable,
  client: Mcp,
  input: EvaluatorPassInput,
  signal: AbortSignal
): Promise<{ state: EvaluationState; reason: string }> {
  const config = await runtime.getConfigurationRegistry().getModelsConfiguration();
  // very short requests ("ok", "thanks") aren't worth a judge round-trip; pass without dispatching or stamping
  const wordCount = (input.question ?? "").trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < config.summaryWordThreshold) return { state: "pass", reason: "" };

  const events = runtime.getEvents();
  events.publish(OrchestratorEventTypes.EVALUATION_START, {});

  let verdict: { state: EvaluationState; reason: string };
  try {
    const result = await client.callTool(EVALUATE_TOOL, { ask: buildJudgeInput(input) }, signal);
    const record = JSON.parse(result.content) as { status?: string; reason?: string };
    verdict = { state: (record.status as EvaluationState) ?? "pass", reason: String(record.reason ?? "") };
    await stampReport(runtime, EVALUATOR_ROLE, record as Record<string, unknown>);
  } catch (err) {
    events.publish(OrchestratorEventTypes.WARNING, {
      message: `evaluation failed, treating as pass: ${(err as Error).message}`,
    });
    verdict = { state: "pass", reason: "evaluator error; defaulting to pass" };
  }

  events.publish(OrchestratorEventTypes.EVALUATION_VERDICT, verdict);
  return verdict;
}

function buildJudgeInput(input: EvaluatorPassInput): string {
  return [
    "ORIGINAL REQUEST:",
    input.question,
    "",
    "PROPOSED FINAL ANSWER:",
    input.proposedAnswer.trim().length > 0
      ? input.proposedAnswer
      : "(the orchestrator produced an empty message)",
    "",
    "TRANSCRIPT OF WORK DONE THIS TURN:",
    input.transcript.map(formatMessageForEvaluation).join("\n"),
  ].join("\n");
}

function formatMessageForEvaluation(message: ChatMessage): string {
  switch (message.role) {
    case "user":
      return `USER: ${message.content}`;
    case "system":
      return `SYSTEM: ${truncate(message.content, 400)}`;
    case "assistant": {
      const calls = message.toolCalls?.length
        ? " [tool-calls: " + message.toolCalls.map((c) => c.name).join(", ") + "]"
        : "";
      return `ASSISTANT: ${message.content}${calls}`;
    }
    case "tool":
      return `TOOL[${message.toolName ?? ""}]: ${truncate(message.content, 600)}`;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}
