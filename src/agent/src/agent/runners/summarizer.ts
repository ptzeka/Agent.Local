import type { ChatMessage } from "../providers/provider.js";
import { AgentRuntimeQueryable } from "../runtime/types.js";

// pure text-in/text-out role: compresses an old conversation prefix into one system message,
// while the orchestrator keeps the last K messages verbatim so recent tool results stay precise
const DEFAULT_TEMPERATURE = 0.2;
const ROLE_NAME = "summarizer";

export interface SummarizeOptions {
  signal?: AbortSignal;
  temperature?: number;
}

export class Summarizer {
 constructor(private readonly runtime: AgentRuntimeQueryable) {}
  public async summarize(
    prefix: readonly ChatMessage[],
    options: SummarizeOptions = {}
  ): Promise<string> {
    const modelsRegistry = this.runtime.getModelsRegistry();
    const provider = this.runtime.getProvidersRegistry().getProvider(modelsRegistry.getProviderForRole("summarizer"));
    const contextLoader = this.runtime.getContextLoader();
    const session = this.runtime.getSession();
    const transcript = prefix.map(formatMessageForSummary).join("\n\n");
    const hash = session.contextHashes![ROLE_NAME];
    const content = await contextLoader.getContextSnapshot(hash)
    let response;
    try {
      response = await provider.chat(
        [
          { role: "system", content: content?.systemPrompt || '' },
          { role: "user", content: transcript },
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
        `Summarizer (${provider.providerName}:${provider.modelId}) failed: ${errorMsg}`
      );
    }

    return response.message.content.trim();
  }
}

// stable machine-detectable prefix so session reset recognises a summary without parsing prose; do not reword
export const SUMMARY_TAG = "[CONVERSATION SUMMARY]";

// the message must tell the reader the work ALREADY happened, so a resumed session doesn't re-execute it
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

// session reset uses this to preserve the latest summary instead of re-running the summarizer
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
