import { describe, expect, test } from "@jest/globals";
import type Anthropic from "@anthropic-ai/sdk";

import { applyMessageBreakpoints } from "../src/agent/providers/anthropic-provider.js";

// The provider marks the last content block (so the next, longer prompt reads this one as a cache hit) and
// a second block ~15 earlier (so the previous entry stays in reach when one iteration appends more than the
// API's 20-block lookback window).

function user(text: string): Anthropic.MessageParam {
  return { role: "user", content: text };
}

function assistant(text: string): Anthropic.MessageParam {
  return { role: "assistant", content: text };
}

function toolResults(count: number): Anthropic.MessageParam {
  return {
    role: "user",
    content: Array.from({ length: count }, (_, i) => ({
      type: "tool_result" as const,
      tool_use_id: `tu_${i}`,
      content: `result ${i}`,
    })),
  };
}

// all blocks across all messages, flattened in order, post-normalisation
function flatBlocks(messages: Anthropic.MessageParam[]): Record<string, unknown>[] {
  return messages.flatMap((m) =>
    typeof m.content === "string"
      ? [{ type: "text", text: m.content }]
      : (m.content as Record<string, unknown>[])
  );
}

function markedIndexes(messages: Anthropic.MessageParam[]): number[] {
  return flatBlocks(messages)
    .map((b, i) => ("cache_control" in b ? i : -1))
    .filter((i) => i >= 0);
}

describe("applyMessageBreakpoints", () => {
  test("marks only the last block of a short conversation", () => {
    const messages = [user("hello"), assistant("hi"), user("do the thing")];

    applyMessageBreakpoints(messages);

    expect(markedIndexes(messages)).toEqual([2]); // last of 3 blocks
  });

  test("normalises string content to a text block only where it marks", () => {
    const messages = [user("hello"), user("latest")];

    applyMessageBreakpoints(messages);

    // Unmarked message keeps its plain-string content (no churn).
    expect(typeof messages[0].content).toBe("string");
    // Marked message was converted so the block can carry cache_control.
    expect(messages[1].content).toEqual([
      { type: "text", text: "latest", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("counts content blocks, not messages, and places the lookback marker", () => {
    // 1 (user) + 18 (tool_results) + 1 (assistant) = 20 blocks total.
    const messages = [user("start"), toolResults(18), assistant("done")];

    applyMessageBreakpoints(messages);

    const marked = markedIndexes(messages);
    // Last block (index 19) and the block 15 positions back from it (19-15=4).
    expect(marked).toEqual([4, 19]);
  });

  test("places exactly two markers no matter how long the conversation is", () => {
    const messages = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0 ? user(`u${i}`) : assistant(`a${i}`)
    );

    applyMessageBreakpoints(messages);

    expect(markedIndexes(messages)).toHaveLength(2);
  });

  test("tolerates an empty message array", () => {
    const messages: Anthropic.MessageParam[] = [];
    expect(() => applyMessageBreakpoints(messages)).not.toThrow();
  });
});
