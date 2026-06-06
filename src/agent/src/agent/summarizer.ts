import type { ChatMessage, LLMProvider } from "./providers/provider.js";

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
