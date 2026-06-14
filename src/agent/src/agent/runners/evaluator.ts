import type { ChatMessage, LLMProvider } from "../providers/provider.js";
import { AgentRuntimeQueryable } from "../runtime/types.js";
import { EVALUATOR_SYSTEM_PROMPT } from "../context/system-prompt.js";

/**
 * Evaluator.
 *
 * The completion gate for an orchestrator turn. When the orchestrator
 * stops calling tools — its way of signalling "I think I'm done" — the
 * evaluator judges the proposed answer against the ORIGINAL user request
 * and the work actually performed this turn. It returns a binary verdict
 * with a reason:
 *
 *   - satisfied  → the orchestrator loop ends; the proposed answer stands.
 *   - !satisfied → the reason is fed back and the orchestrator keeps
 *                  looping until the request is genuinely fulfilled (or
 *                  the safety iteration cap trips).
 *
 * The evaluator is deliberately conservative about blocking: it only
 * returns UNSATISFIED when something concrete is missing, and it
 * fails OPEN (treats an unparseable response as satisfied) so a flaky
 * judge can never trap the user in an endless loop.
 */

const DEFAULT_TEMPERATURE = 0.1;

/**
 * Five-state verdict:
 *   - "satisfied"       → the request is fully met; the orchestrator turn ends.
 *   - "continue"        → real progress, on the right track; nudge to keep going.
 *   - "unsatisfied"     → stuck or off track; force a change of approach.
 *   - "awaiting-input"  → blocked waiting for user clarification; turn pauses.
 *   - "failed"          → the request cannot be completed; stop trying. Terminal,
 *                         unlike "unsatisfied" which keeps looping.
 */
export type EvaluationState = "satisfied" | "continue" | "unsatisfied" | "awaiting-input" | "failed";

export interface EvaluationVerdict {
  state: EvaluationState;
  reason: string;
}

export interface EvaluateParams {
  /** The user's original request for this turn. */
  question: string;
  /** The orchestrator's candidate final answer (its tool-free message). */
  proposedAnswer: string;
  /** The turn's working transcript, used to see what actually happened. */
  transcript: ChatMessage[];
}

export interface EvaluateOptions {
  signal?: AbortSignal;
  temperature?: number;
}

export class Evaluator {
  constructor(private readonly runtime: AgentRuntimeQueryable) {}

  public async evaluate(
    params: EvaluateParams,
    options: EvaluateOptions = {}
  ): Promise<EvaluationVerdict> {
    const modelsRegistry = this.runtime.getModelsRegistry();
    const provider = this.runtime.getProvidersRegistry().getProvider(modelsRegistry.getProviderForRole("evaluator"));
    const userMessage = [
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

    let response;
    try {
      response = await provider.chat(
        [
          { role: "system", content: EVALUATOR_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        {
          tools: [],
          temperature: options.temperature ?? DEFAULT_TEMPERATURE,
          signal: options.signal,
        }
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Evaluator (${provider.providerName}:${provider.modelId}) failed: ${errorMsg}`
      );
    }

    return parseVerdict(response.message.content);
  }
}

/**
 * Parse the single EVALUATOR verdict line. Fails OPEN: if no recognisable
 * verdict is present, we treat the turn as satisfied so a malformed judge
 * response can never trap the orchestrator in an endless loop.
 */
function parseVerdict(content: string): EvaluationVerdict {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    const match = line.match(/^EVALUATOR:\s*(SATISFIED|CONTINUE|UNSATISFIED|AWAITING-INPUT|AWAITING_INPUT|FAILED)\b\s*(.*)$/i);
    if (match) {
      let state = match[1].toLowerCase().replace(/_/g, "-") as EvaluationState;
      const reason = match[2].trim() || DEFAULT_REASON[state];
      return { state, reason };
    }
  }
  return {
    state: "satisfied",
    reason: "evaluator returned no parseable verdict; defaulting to satisfied",
  };
}

const DEFAULT_REASON: Record<EvaluationState, string> = {
  satisfied: "request addressed",
  continue: "making progress; continue with the next step",
  unsatisfied: "not making progress; change approach",
  "awaiting-input": "orchestrator is waiting for user input",
  failed: "request cannot be completed",
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
