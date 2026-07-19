import type { ToolDescriptor } from "@agent-local/mcp";
import type { ChatMessage, LLMProvider } from "../../providers/provider.js";
import type { ContextSnapshot } from "../../context/context-loader.js";
import { buildPromptedToolInstructions } from "../../tool-adapter.js";
import { Round, type RoundOutcome } from "./iround.js";
import type { Turn } from "./turn.js";

// turn-start context assembly: builds the system/context prefix (standing project direction + the
// system prompt + prompted-tool instructions for non-native models) and seeds it into the working set.
// runs once per turn, before summarization, so every downstream round shares the same standing context
export class SystemMessagesRound extends Round {
  async runAsync(turn: Turn): Promise<RoundOutcome> {
    if (turn.contextBuilt) return { kind: "continue" };
    turn.contextBuilt = true;

    turn.setContextMessages(this.build(turn.provider, turn.visibleTools, turn.context));
    return { kind: "continue" };
  }

  private build(
    provider: LLMProvider,
    visibleTools: ToolDescriptor[],
    context: ContextSnapshot
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];

    if (context.projectContext) {
      messages.push({
        role: "system",
        content:
          `Treat this as standing direction from the user; follow it unless ` +
          `a specific request overrides it.\n\n` +
          context.projectContext,
      });
    }

    // built per-turn because the live tool set can differ from the snapshot's (subsessions rebound each turn)
    const promptedInstructions = provider.supportsNativeTools
      ? ""
      : buildPromptedToolInstructions(visibleTools);

    messages.push({
      role: "system",
      content: context.systemPrompt + promptedInstructions,
    });

    return messages;
  }
}
