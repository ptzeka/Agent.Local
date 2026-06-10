import type { ChatMessage, LLMProvider } from "../providers/provider.js";

/**
 * Summarizer.
 *
 * Compresses an old prefix of the orchestrator conversation into a single
 * "conversation-so-far" note. The orchestrator splices the result back in
 * as one `role: "system"` message, preserving the last K messages
 * verbatim so recent tool results remain precise.
 *
 * The summarizer never sees the live system prompts and never invokes
 * tools — it is a pure text-in, text-out role.
 */

const SUMMARIZER_SYSTEM_PROMPT = `You are the SUMMARIZER.

You receive a prefix of an agent conversation transcript: user messages,
orchestrator assistant turns, tool calls, and tool results. Your job is
to compress that prefix into a single concise "conversation-so-far" note
that preserves only what the orchestrator will need to keep working.

Preserve:
  - The user's outstanding goal(s) and any specific facts, IDs, or paths
    they mentioned.
  - Decisions already made and the reason behind them.
  - Mutations that actually landed (executor RESULT OK lines), with file
    paths and a one-line description of what changed.
  - Open failures the orchestrator should not retry blindly.

Drop:
  - Verbatim tool output beyond what's needed to recall the result.
  - Iterative LLM deliberation and recovered-from errors.
  - Anything restated in messages that will be kept verbatim after the
    summary (the orchestrator preserves a recent tail).

Reply with a single plain-text block. No markdown headings, no preamble,
no closing remarks. Keep it under 30 lines.`;

const DEFAULT_TEMPERATURE = 0.2;

export interface SummarizeOptions {
  signal?: AbortSignal;
  temperature?: number;
}

export class Summarizer {
  constructor(private readonly provider: LLMProvider) {}

  public async summarize(
    prefix: ChatMessage[],
    options: SummarizeOptions = {}
  ): Promise<string> {
    const transcript = prefix.map(formatMessageForSummary).join("\n\n");

    const response = await this.provider.chat(
      [
        { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
      {
        tools: [],
        temperature: options.temperature ?? DEFAULT_TEMPERATURE,
        signal: options.signal,
      }
    );

    return response.message.content.trim();
  }
}

/**
 * Sentinel that marks a spliced "conversation-so-far" system message. Kept as a
 * stable, machine-detectable prefix so other components (e.g. session reset) can
 * recognise the summary without re-parsing prose. Do not localise or reword it.
 */
export const SUMMARY_TAG = "[CONVERSATION SUMMARY]";

/**
 * Build the single `system` message the orchestrator splices in place of the
 * compressed prefix. Beyond the summary text, it tells the reader two things:
 * the summary is ground-truth context, and — crucially for resuming after a
 * reset — the work it describes ALREADY happened and must not be re-executed.
 */
export function buildSummaryMessage(summaryText: string, summarizedCount: number): ChatMessage {
  return {
    role: "system",
    content:
      `${SUMMARY_TAG}\n` +
      `This is a condensed summary of ${summarizedCount} earlier message(s), ` +
      `produced by the summarizer model. Treat it as ground-truth context for ` +
      `everything that happened before the messages below.\n` +
      `The actions it describes have ALREADY been performed — continue from here; ` +
      `do not re-execute work the summary reports as done.\n\n` +
      summaryText,
  };
}

/**
 * True when `message` is a spliced summary checkpoint. Used by session reset to
 * preserve the latest summary (so a reset session can continue from it) instead
 * of re-running the summarizer.
 */
export function isSummaryMessage(message: ChatMessage): boolean {
  return message.role === "system" && message.content.startsWith(SUMMARY_TAG);
}

function formatMessageForSummary(message: ChatMessage): string {
  switch (message.role) {
    case "user":
      return `USER: ${message.content}`;
    case "system":
      return `SYSTEM: ${message.content}`;
    case "assistant": {
      const calls = message.toolCalls?.length
        ? "\n  tool-calls: " +
          message.toolCalls
            .map((c) => `${c.name}(${stringifyArgsCompact(c.arguments)})`)
            .join("; ")
        : "";
      return `ASSISTANT: ${message.content}${calls}`;
    }
    case "tool":
      return `TOOL[${message.toolName ?? ""}]: ${message.content}`;
  }
}

function stringifyArgsCompact(args: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(args);
    return json.length > 200 ? json.slice(0, 200) + "..." : json;
  } catch {
    return "{}";
  }
}
