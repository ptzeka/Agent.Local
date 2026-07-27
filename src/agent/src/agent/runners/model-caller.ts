import type { Eventing } from "@agent-local/common/eventing";
import type {
  ChatMessage,
  ChatResponse,
  LLMProvider,
  ToolCall,
} from "../providers/provider.js";
import { extractPromptedToolCalls } from "../tool-adapter.js";
import { OrchestratorEventTypes } from "./runner-events.js";
import type { RunnerContext } from "./middleware/runner-middleware.js";
import type { Turn } from "./turn.js";

// what one model call yields; plain data, so the caller can never end the turn from here
export interface ModelReply {
  assistantMessage: ChatMessage;
  toolCalls: ToolCall[];
}

// one model call: anchors the request, streams the reply, normalises tool calls, and appends the
// assistant turn. part of the loop itself, not an extension point — it decides nothing
export class ModelCaller {
  async call(turn: Turn, ctx: RunnerContext): Promise<ModelReply> {
    const turnEvents = ctx.events;
    const modelsRegistry = ctx.runtime.getModelsRegistry();
    const provider = turn.provider;

    // transient last message every call so the model stays anchored as the transcript grows
    const requestAnchor: ChatMessage = {
      role: "system",
      content: modelsRegistry.getAnchorText(turn.turnRequest!),
    };

    ctx.logger.debug("model call", {
      turnId: turn.id,
      provider: provider.providerName,
      model: provider.modelId,
    });

    // lazily open the chat stream on the first text delta so a tool-only/empty turn never prints a bare [emitter] label
    const onDelta = turn.streaming
      ? (delta: string) => {
          if (!turn.chatStarted) {
            turn.chatStarted = true;
            turnEvents.publish(OrchestratorEventTypes.CHAT_START, { emitter: turn.profile.role });
          }
          turnEvents.publish(OrchestratorEventTypes.MESSAGE_DELTA, { turnId: turn.id, delta });
        }
      : undefined;

    let response: ChatResponse;
    try {
      response = await provider.chat([...turn.workingMessages, requestAnchor], {
        tools: provider.supportsNativeTools ? turn.visibleTools : [],
        temperature: turn.profile.temperature,
        signal: ctx.signal,
        onDelta,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Orchestrator (${provider.providerName}:${provider.modelId}) failed at iteration ${turn.iteration}: ${errorMsg}`
      );
    }

    // stamp before publish so the own-spend round is attributable once it leaves this runtime;
    // TurnCounterMiddleware folds it into the MetricsRegistry off the orchestrator-message event below
    if (response.usage) response.usage.sessionId = ctx.session.sessionId;

    const reply = this.normaliseAssistantTurn(provider, response, turnEvents);

    // Content length + tool count distinguish a real answer from an empty reply.
    ctx.logger.debug("model response", {
      turnId: turn.id,
      contentLength: reply.assistantMessage.content.length,
      toolCalls: reply.toolCalls.length,
    });

    turnEvents.publish(OrchestratorEventTypes.MESSAGE, {
      turnId: turn.id,
      content: reply.assistantMessage.content,
      toolCallCount: reply.toolCalls.length,
      usage: response.usage,
    });

    turn.append(reply.assistantMessage);
    return reply;
  }

  private normaliseAssistantTurn(
    provider: LLMProvider,
    response: ChatResponse,
    events: Eventing
  ): ModelReply {
    if (provider.supportsNativeTools) {
      const nativeCalls = response.message.toolCalls ?? [];
      if (nativeCalls.length > 0) {
        return { assistantMessage: response.message, toolCalls: nativeCalls };
      }

      const { toolCalls: recoveredCalls, cleanedContent } = extractPromptedToolCalls(response.message);
      if (recoveredCalls.length > 0) {
        events.publish(OrchestratorEventTypes.WARNING, {
          message:
            "Native-tool model emitted tool call as JSON in prose; recovered via prompted-JSON fallback.",
          model: provider.modelId,
          recoveredCount: recoveredCalls.length,
        });
        return {
          assistantMessage: {
            role: "assistant",
            content: cleanedContent,
            toolCalls: recoveredCalls,
          },
          toolCalls: recoveredCalls,
        };
      }
      return { assistantMessage: response.message, toolCalls: nativeCalls };
    }

    const { toolCalls, cleanedContent } = extractPromptedToolCalls(response.message);
    return {
      assistantMessage: {
        role: "assistant",
        content: cleanedContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      toolCalls,
    };
  }
}
