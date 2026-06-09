import { describe, expect, test } from "@jest/globals";
import type { GenerateContentResponse } from "@google/genai";

import {
  fromGeminiResponse,
  toGeminiMessages,
} from "../src/agent/providers/gemini-provider.js";
import type { ChatMessage } from "../src/agent/providers/provider.js";

/**
 * Gemini thoughtSignature round-trip tests.
 *
 * Thinking models attach an opaque `thoughtSignature` to each functionCall
 * part and reject (HTTP 400) any later request that replays the call without
 * it. These lock in that the signature is captured off the response and echoed
 * back verbatim when the conversation is replayed.
 */

/** Minimal GenerateContentResponse stand-in carrying just the parts we read. */
function responseWithParts(
  parts: Array<Record<string, unknown>>
): GenerateContentResponse {
  return {
    candidates: [{ content: { parts } }],
  } as unknown as GenerateContentResponse;
}

describe("fromGeminiResponse", () => {
  test("captures thoughtSignature from a functionCall part onto the ToolCall", () => {
    const response = responseWithParts([
      { functionCall: { name: "do_thing", args: { a: 1 } }, thoughtSignature: "sig-xyz" },
    ]);

    const { toolCalls } = fromGeminiResponse(response);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ name: "do_thing", signature: "sig-xyz" });
  });

  test("concatenates text parts and skips thought parts when building content", () => {
    const response = responseWithParts([
      { text: "internal reasoning", thought: true },
      { text: "visible answer" },
    ]);

    const { content, toolCalls } = fromGeminiResponse(response);

    expect(content).toBe("visible answer");
    expect(toolCalls).toHaveLength(0);
  });

  test("leaves signature undefined when the part has none", () => {
    const response = responseWithParts([
      { functionCall: { name: "do_thing", args: {} } },
    ]);

    const { toolCalls } = fromGeminiResponse(response);

    expect(toolCalls[0].signature).toBeUndefined();
  });
});

describe("toGeminiMessages", () => {
  test("echoes the signature back onto the replayed functionCall part", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "do_thing", name: "do_thing", arguments: {}, signature: "sig-xyz" }],
      },
    ];

    const { contents } = toGeminiMessages(messages);

    const modelTurn = contents[0];
    expect(modelTurn.role).toBe("model");
    expect(modelTurn.parts?.[0]).toMatchObject({
      functionCall: { name: "do_thing" },
      thoughtSignature: "sig-xyz",
    });
  });

  test("omits thoughtSignature when the ToolCall carries none", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "do_thing", name: "do_thing", arguments: {} }],
      },
    ];

    const { contents } = toGeminiMessages(messages);

    expect(contents[0].parts?.[0]).not.toHaveProperty("thoughtSignature");
  });
});

describe("response → replay round-trip", () => {
  test("a captured signature survives back into the next request", () => {
    const { toolCalls } = fromGeminiResponse(
      responseWithParts([
        { functionCall: { name: "do_thing", args: { a: 1 } }, thoughtSignature: "sig-abc" },
      ])
    );

    const assistant: ChatMessage = { role: "assistant", content: "", toolCalls };
    const { contents } = toGeminiMessages([assistant]);

    expect(contents[0].parts?.[0]).toMatchObject({ thoughtSignature: "sig-abc" });
  });
});
