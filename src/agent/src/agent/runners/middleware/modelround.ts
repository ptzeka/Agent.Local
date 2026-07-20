import type {
  ChatMessage,
  ChatResponse,
  LLMProvider,
  ToolCall,
} from "../../providers/provider.js";
import { extractPromptedToolCalls } from "../../tool-adapter.js";
import { OrchestratorEventTypes } from "../runner-events.js";
import type { Eventing } from "@agent-local/common/eventing";
import { Round, type RoundOutcome } from "./iround.js";
import type { Turn } from "./turn.js";

// one model call: anchors the request, streams the reply, normalises tool calls,
// and appends the assistant turn — leaving assistantMessage/toolCalls for the rounds after it
export class ModelRound extends Round {
  async runAsync(turn: Turn): Promise<RoundOutcome> {
    const turnEvents = this.context.events;
    const modelsRegistry = this.context.runtime.getModelsRegistry();
    const provider = turn.provider;

    // transient last message every call so the model stays anchored as the transcript grows
    const requestAnchor: ChatMessage = {
      role: "system",
      content: modelsRegistry.getAnchorText(turn.turnRequest!),
    };

    this.context.logger.debug("model call", {
      turnId: turn.id,
      provider: provider.providerName,
      model: provider.modelId,
    });

    // lazily open the chat stream on the first text delta so a tool-only/empty turn never prints a bare [emitter] label
    const onDelta = turn.streaming
      ? (delta: string) => {
          if (!turn.chatStarted) {
            turn.chatStarted = true;
            turnEvents.publish(OrchestratorEventTypes.CHAT_START, { emitter: turn.role });
          }
          turnEvents.publish(OrchestratorEventTypes.MESSAGE_DELTA, {
            turnId: turn.id,
            delta,
          });
        }
      : undefined;

    let response: ChatResponse;
    try {
      response = await provider.chat([...turn.workingMessages, requestAnchor], {
        tools: provider.supportsNativeTools ? turn.visibleTools : [],
        temperature: turn.temperature,
        signal: this.context.signal,
        onDelta,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Orchestrator (${provider.providerName}:${provider.modelId}) failed at iteration ${turn.id}: ${errorMsg}`
      );
    }

    // stamp before publish so the own-spend round is attributable once it leaves this runtime;
    // TurnCounterMiddleware folds it into the MetricsRegistry off the orchestrator-message event below
    if (response.usage) response.usage.sessionId = this.context.session.sessionId;

    const { assistantMessage, toolCalls } = this.normaliseAssistantTurn(
      provider,
      response,
      turnEvents
    );

    // Content length + tool count distinguish a real answer from an empty reply.
    this.context.logger.debug("model response", {
      turnId: turn.id,
      contentLength: assistantMessage.content.length,
      toolCalls: toolCalls.length,
    });

    turnEvents.publish(OrchestratorEventTypes.MESSAGE, {
      turnId: turn.id,
      content: assistantMessage.content,
      toolCallCount: toolCalls.length,
      usage: response.usage,
    });

    turn.append(assistantMessage);
    turn.assistantMessage = assistantMessage;
    turn.toolCalls = toolCalls;

    return { kind: "continue" };
  }

  private normaliseAssistantTurn(
    provider: LLMProvider,
    response: ChatResponse,
    events: Eventing
  ): { assistantMessage: ChatMessage; toolCalls: ToolCall[] } {
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
