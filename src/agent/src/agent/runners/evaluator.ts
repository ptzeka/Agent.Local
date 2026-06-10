import type { ChatMessage, LLMProvider } from "../providers/provider.js";

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

const EVALUATOR_SYSTEM_PROMPT = `You are the EVALUATOR.

You are given:
  - The user's ORIGINAL request for this turn.
  - The orchestrator's PROPOSED final answer.
  - A TRANSCRIPT of what the orchestrator actually did (tool calls,
    executor results, read-backs).

Decide ONE of three states for this turn, and reply with EXACTLY one
line, no prose before or after:
    EVALUATOR: SATISFIED <why the request is fully met>
    EVALUATOR: CONTINUE <progress made so far + the next concrete step>
    EVALUATOR: UNSATISFIED <why the work is stuck or off track>

How to choose:
  - SATISFIED — the user's request is fully accomplished. Do not invent
    extra requirements they never asked for.
  - CONTINUE — not done yet, but the orchestrator is making real progress
    toward the request and is on the right track. This is the NORMAL
    verdict for partially-finished work: acknowledge the progress and name
    the next step. Prefer CONTINUE over UNSATISFIED whenever genuine
    forward progress is visible (e.g. files are being created, the right
    directory was just made, an executor reported OK on a needed step).
  - UNSATISFIED — the orchestrator is NOT making progress: it keeps
    repeating a failing action, is working on the wrong thing relative to
    the request, or is contradicting what was asked. Use this to force a
    change of approach, not merely to note that work remains.

  Judge against what was ASKED, not against perfection.`;

const DEFAULT_TEMPERATURE = 0.1;

/**
 * Three-state verdict:
 *   - "satisfied"   → the request is fully met; the orchestrator turn ends.
 *   - "continue"    → real progress, on the right track; nudge to keep going.
 *   - "unsatisfied" → stuck or off track; force a change of approach.
 * Both non-satisfied states keep the loop running, with different steering.
 */
export type EvaluationState = "satisfied" | "continue" | "unsatisfied";

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
  constructor(private readonly provider: LLMProvider) {}

  public async evaluate(
    params: EvaluateParams,
    options: EvaluateOptions = {}
  ): Promise<EvaluationVerdict> {
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

    const response = await this.provider.chat(
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
    const match = line.match(/^EVALUATOR:\s*(SATISFIED|CONTINUE|UNSATISFIED)\b\s*(.*)$/i);
    if (match) {
      const state = match[1].toLowerCase() as EvaluationState;
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
