import { describe, expect, test } from "@jest/globals";
import type Anthropic from "@anthropic-ai/sdk";

import { repairToolPairing } from "../src/agent/providers/anthropic-provider.js";

/**
 * repairToolPairing tests.
 *
 * The Messages API requires every assistant `tool_use` to be answered by a
 * `tool_result` in the immediately-following user turn. These cover the
 * poisoned-transcript shapes a real interruption leaves behind.
 */

const toolUse = (id: string): Anthropic.ContentBlockParam => ({
  type: "tool_use",
  id,
  name: "do_thing",
  input: {},
});

/** Pull the tool_result ids out of a user turn (or [] for anything else). */
function resultIds(message: Anthropic.MessageParam | undefined): string[] {
  if (!message || message.role !== "user" || !Array.isArray(message.content)) return [];
  return message.content
    .filter((b) => typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_result")
    .map((b) => (b as Anthropic.ToolResultBlockParam).tool_use_id);
}

describe("repairToolPairing", () => {
  test("leaves a well-formed transcript untouched", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "do it" },
      { role: "assistant", content: [toolUse("a")] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] },
    ];
    const out = repairToolPairing(messages);
    expect(out).toHaveLength(3);
    expect(resultIds(out[2])).toEqual(["a"]);
  });

  test("dangling tool_use followed by a user turn: synthesizes the missing result", () => {
    // The exact poison shape: [user, assistant(tool_use), user] with no result.
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "do it" },
      { role: "assistant", content: [toolUse("a")] },
      { role: "user", content: "continue the work" },
    ];
    const out = repairToolPairing(messages);

    // Still three turns (the synthetic result folds INTO the next user turn,
    // never creating two consecutive user turns).
    expect(out).toHaveLength(3);
    expect(out[1].role).toBe("assistant");
    expect(out[2].role).toBe("user");

    // The next user turn now leads with the synthetic, error-flagged result for
    // "a", and still carries the original user text.
    const blocks = out[2].content as Anthropic.ContentBlockParam[];
    expect(blocks[0]).toMatchObject({ type: "tool_result", tool_use_id: "a", is_error: true });
    expect(blocks.some((b) => (b as { type?: string }).type === "text")).toBe(true);
  });

  test("dangling tool_use at the end of the transcript: appends a result turn", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "do it" },
      { role: "assistant", content: [toolUse("a")] },
    ];
    const out = repairToolPairing(messages);
    expect(out).toHaveLength(3);
    expect(out[2].role).toBe("user");
    expect(resultIds(out[2])).toEqual(["a"]);
  });

  test("multiple tool_use blocks: only the unanswered id is synthesized", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "assistant", content: [toolUse("a"), toolUse("b")] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] },
    ];
    const out = repairToolPairing(messages);
    // "a" was already answered; "b" gets a synthetic result merged into the same
    // user turn, which stays a single turn.
    expect(out).toHaveLength(2);
    expect(resultIds(out[1]).sort()).toEqual(["a", "b"]);
  });
});
