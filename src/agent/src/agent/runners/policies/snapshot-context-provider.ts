import type { ToolDescriptor } from "@agent-local/mcp";
import type { ContextSnapshot } from "../../context/context-loader.js";
import type { ChatMessage, LLMProvider } from "../../providers/provider.js";
import { buildPromptedToolInstructions } from "../../tool-adapter.js";
import type { RunnerContext } from "../middleware/runner-middleware.js";
import type { Turn } from "../turn.js";
import type { ContextProvider } from "./types.js";

// the default context provider: standing project direction + system prompt + prompted-tool
// instructions for non-native models, all resolved from the role's hashed snapshot
export class SnapshotContextProvider implements ContextProvider {
  async build(turn: Turn, ctx: RunnerContext): Promise<ChatMessage[]> {
    const snapshot = await this.loadSnapshot(turn.profile.role, ctx);
    return this.assemble(turn.provider, turn.visibleTools, snapshot);
  }

  // the ContextMiddleware snapshot is the ONLY source of prompt+direction, so what ran always matches the hash
  private async loadSnapshot(role: string, ctx: RunnerContext): Promise<ContextSnapshot> {
    const contextHash = ctx.session.contextHashes ? ctx.session.contextHashes[role] : null;
    const snapshot = contextHash
      ? await ctx.runtime.getContextLoader().getContextSnapshot(contextHash)
      : null;
    if (!snapshot) {
      throw new Error(
        `Orchestrator: no context snapshot for role "${role}" ` +
          `(hash: ${contextHash ?? "unstamped"}). ContextMiddleware must run before any turn.`
      );
    }
    return snapshot;
  }

  private assemble(
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
