import type { ChatMessage } from "../../providers/provider.js";
import { OrchestratorEventTypes } from "../runner-events.js";
import { Summarizer, buildSummaryMessage } from "../summarizer.js";
import type { RunnerContext } from "../middleware/runner-middleware.js";
import type { Turn } from "../turn.js";
import type { CompactionPolicy } from "./types.js";

// the default compaction: over the threshold, compresses the old history prefix into one summary
// message and reseeds the working set, keeping the last K messages verbatim
// fails open so a flaky summarizer never blocks the turn
export class SummarizeCompaction implements CompactionPolicy {
  async applyIfNeeded(turn: Turn, ctx: RunnerContext): Promise<void> {
    const orchestration = turn.config.orchestration;
    const messages = turn.history();
    if (messages.length <= orchestration.summarizeAtMessages!) return;

    const tailStart = findCleanTailStart(messages, orchestration.summarizerKeepLastN!);
    if (tailStart === 0) return;

    const prefix = messages.slice(0, tailStart);
    const tail = messages.slice(tailStart);

    const events = ctx.events;
    events.publish(OrchestratorEventTypes.SUMMARIZATION_START, { messageCount: prefix.length });

    let summaryText: string;
    try {
      const summarizer = new Summarizer(ctx.runtime);
      summaryText = await summarizer.summarize(prefix, { signal: ctx.signal });
    } catch (err) {
      events.publish(OrchestratorEventTypes.WARNING, {
        message: `summarization failed: ${(err as Error).message}`,
      });
      return;
    }

    await turn.replaceHistory([buildSummaryMessage(summaryText, prefix.length), ...tail]);

    events.publish(OrchestratorEventTypes.SUMMARIZATION, {
      summarizedCount: prefix.length,
      keptCount: tail.length,
      summaryChars: summaryText.length,
    });
  }
}

// finds a tail-start that can legally HEAD a provider contents array (a user turn, or a
// non-tool-call assistant turn), skipping orphan tool results and tool-call turns that providers reject
function findCleanTailStart(messages: readonly ChatMessage[], desiredTailLen: number): number {
  const initial = Math.max(0, messages.length - desiredTailLen);
  for (let i = initial; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === "user") return i;
    if (message.role === "assistant" && !(message.toolCalls && message.toolCalls.length > 0)) {
      return i;
    }
  }
  return messages.length;
}
