import type { ChatMessage, LLMProvider } from "../providers/provider.js";
import { AgentRuntimeQueryable } from "../runtime/types.js";
import { EVALUATOR_SYSTEM_PROMPT } from "../context/system-prompt.js";
import { OrchestratorEventTypes } from "./runner-events.js";

// terminal judge pass: a separate role reads this turn's transcript and stamps a structured verdict
// into the conversation. fails OPEN (unparseable → pass) so a flaky judge can never trap the caller
const DEFAULT_TEMPERATURE = 0.1;

// the config role whose model backs the judge; a constant so the name isn't a scattered literal (cf. EXECUTOR_ROLE)
export const EVALUATOR_ROLE = "evaluator" as const;

// three states the LLM (or a headless consumer) can act on: done, unrecoverable, or more work remains
export type EvaluationState = "pass" | "fail" | "incomplete";

export interface EvaluationVerdict {
  state: EvaluationState;
  reason: string;
}

export interface EvaluateParams {
  question: string;
  // the orchestrator's tool-free message proposed as the final answer
  proposedAnswer: string;
  transcript: ChatMessage[];
}

export interface EvaluateOptions {
  signal?: AbortSignal;
  temperature?: number;
}

export class Evaluator {
  constructor(private readonly runtime: AgentRuntimeQueryable) {}

  // judges the proposed answer against the transcript, then STAMPS the verdict into the conversation as a
  // structured `EVALUATOR: <STATE> — <reason>` line so both the model (next pass) and a headless job can read it
  public async evaluate(
    params: EvaluateParams,
    options: EvaluateOptions = {}
  ): Promise<EvaluationVerdict> {
    const config = await this.runtime.getConfigurationRegistry().getModelsConfiguration();

    // very short requests ("ok", "thanks") aren't worth a judge round-trip; pass without stamping
    const wordCount = (params.question ?? "").trim().split(/\s+/).filter(Boolean).length;
    if (wordCount < config.summaryWordThreshold) {
      return { state: "pass", reason: "" };
    }

    this.runtime.getEvents().publish(OrchestratorEventTypes.EVALUATION_START, {});

    let verdict: EvaluationVerdict;
    try {
      const modelsRegistry = this.runtime.getModelsRegistry();
      const provider = this.runtime.getProvidersRegistry().getProvider(modelsRegistry.getProviderForRole(EVALUATOR_ROLE));
      const response = await provider.chat(
        [
          { role: "system", content: EVALUATOR_SYSTEM_PROMPT },
          { role: "user", content: buildJudgeInput(params) },
        ],
        {
          tools: [],
          temperature: options.temperature ?? DEFAULT_TEMPERATURE,
          signal: options.signal,
        }
      );
      verdict = parseVerdict(response.message.content);
    } catch (err) {
      // fail open: never trap the caller because the judge errored
      this.runtime.getEvents().publish(OrchestratorEventTypes.WARNING, {
        message: `evaluation failed, treating as pass: ${(err as Error).message}`,
      });
      verdict = { state: "pass", reason: "evaluator error; defaulting to pass" };
    }

    await this.stamp(verdict);
    this.runtime.getEvents().publish(OrchestratorEventTypes.EVALUATION_VERDICT, {
      state: verdict.state,
      reason: verdict.reason,
    });
    return verdict;
  }

  // persists the structured verdict as its own conversation line so it survives into later turns
  private async stamp(verdict: EvaluationVerdict): Promise<void> {
    const line = `EVALUATOR: ${verdict.state.toUpperCase()} — ${verdict.reason}`;
    const conversation = this.runtime.getConversation();
    conversation.append({ role: "system", content: line });
    await conversation.flush();
  }
}

function buildJudgeInput(params: EvaluateParams): string {
  return [
    "ORIGINAL REQUEST:",
    params.question,
    "",
    "PROPOSED FINAL ANSWER:",
    params.proposedAnswer.trim().length > 0
      ? params.proposedAnswer
      : "(the orchestrator produced an empty message)",
    "",
    "TRANSCRIPT OF WORK DONE THIS TURN:",
    params.transcript.map(formatMessageForEvaluation).join("\n"),
  ].join("\n");
}

// fails OPEN: no recognisable verdict → pass, so a malformed judge can't trap the caller
function parseVerdict(content: string): EvaluationVerdict {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    const match = line.match(/^EVALUATOR:\s*(PASS|FAIL|INCOMPLETE)\b\s*[—-]?\s*(.*)$/i);
    if (match) {
      const state = match[1].toLowerCase() as EvaluationState;
      const reason = match[2].trim() || DEFAULT_REASON[state];
      return { state, reason };
    }
  }
  return {
    state: "pass",
    reason: "evaluator returned no parseable verdict; defaulting to pass",
  };
}

const DEFAULT_REASON: Record<EvaluationState, string> = {
  pass: "request addressed",
  fail: "request cannot be completed",
  incomplete: "more work remains toward the request",
};

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
