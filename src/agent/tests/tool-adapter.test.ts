import { describe, expect, test } from "@jest/globals";

import type { ChatMessage, ToolDescriptor } from "../src/agent/providers/provider.js";
import {
  buildPromptedToolInstructions,
  extractPromptedToolCalls,
} from "../src/agent/tool-adapter.js";

/**
 * tool-adapter tests.
 *
 * Both functions are pure (no I/O, no clock dependence beyond the generated
 * call id), so these are straightforward input → output assertions covering the
 * native-less "prompted JSON" strategy: building the instruction addendum and
 * recovering tool calls from assistant text.
 */

const SAMPLE_TOOL: ToolDescriptor = {
  name: "read_file",
  description: "Read a file from disk",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

/** Build the assistant message shape the extractor consumes. */
function assistant(content: string): ChatMessage {
  return { role: "assistant", content };
}

describe("buildPromptedToolInstructions", () => {
  test("returns an empty string when there are no tools", () => {
    expect(buildPromptedToolInstructions([])).toBe("");
  });

  test("lists each tool's name, description, and schema plus the invocation rules", () => {
    const result = buildPromptedToolInstructions([SAMPLE_TOOL]);

    expect(result).toContain("read_file");
    expect(result).toContain("Read a file from disk");
    // The JSON schema is rendered into the block.
    expect(result).toContain('"properties"');
    // The how-to-invoke scaffolding is present.
    expect(result).toContain("## Available tools");
    expect(result).toContain("single fenced JSON block");
    expect(result).toContain("Emit at most one tool_call block per turn.");
  });
});

describe("extractPromptedToolCalls", () => {
  test("extracts a fenced tool_call block and strips it from the visible content", () => {
    const message = assistant(
      ['Let me read that file.', '```json', '{ "tool_call": { "name": "read_file", "arguments": { "path": "a.txt" } } }', '```'].join(
        "\n"
      )
    );

    const { toolCalls, cleanedContent } = extractPromptedToolCalls(message);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("read_file");
    expect(toolCalls[0].arguments).toEqual({ path: "a.txt" });
    expect(toolCalls[0].id).toMatch(/^prompted_/);
    // The fenced block is removed; the surrounding prose remains.
    expect(cleanedContent).toBe("Let me read that file.");
  });

  test("accepts a bare {name, arguments} shape without the tool_call wrapper", () => {
    const message = assistant('```json\n{ "name": "read_file", "arguments": { "path": "b.txt" } }\n```');

    const { toolCalls } = extractPromptedToolCalls(message);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("read_file");
    expect(toolCalls[0].arguments).toEqual({ path: "b.txt" });
  });

  test("defaults arguments to an empty object when the fenced call omits them", () => {
    const message = assistant('```json\n{ "tool_call": { "name": "list_dir" } }\n```');

    const { toolCalls } = extractPromptedToolCalls(message);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].arguments).toEqual({});
  });

  test("extracts multiple fenced blocks in order", () => {
    const message = assistant(
      [
        '```json',
        '{ "tool_call": { "name": "read_file", "arguments": { "path": "a" } } }',
        '```',
        'and then',
        '```json',
        '{ "tool_call": { "name": "read_file", "arguments": { "path": "b" } } }',
        '```',
      ].join("\n")
    );

    const { toolCalls } = extractPromptedToolCalls(message);

    expect(toolCalls.map((c) => c.arguments)).toEqual([{ path: "a" }, { path: "b" }]);
  });

  test("leaves an invalid JSON block in place and reports no calls", () => {
    const content = '```json\n{ not valid json }\n```';
    const message = assistant(content);

    const { toolCalls, cleanedContent } = extractPromptedToolCalls(message);

    expect(toolCalls).toHaveLength(0);
    // Untouched so the model can see its own malformed output next turn.
    expect(cleanedContent).toBe(content);
  });

  test("returns no calls for ordinary prose", () => {
    const message = assistant("Here is the answer: the file contains a greeting.");

    const { toolCalls, cleanedContent } = extractPromptedToolCalls(message);

    expect(toolCalls).toHaveLength(0);
    expect(cleanedContent).toBe("Here is the answer: the file contains a greeting.");
  });

  test("recovers a bare, unfenced JSON tool call as a fallback", () => {
    const message = assistant(
      'Sure: { "tool_call": { "name": "read_file", "arguments": { "path": "c.txt" } } }'
    );

    const { toolCalls, cleanedContent } = extractPromptedToolCalls(message);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("read_file");
    expect(toolCalls[0].arguments).toEqual({ path: "c.txt" });
    expect(cleanedContent).toBe("Sure:");
  });

  test("does not treat bare JSON lacking an arguments object as a call", () => {
    // The bare-JSON fallback requires a real arguments object, so a model
    // legitimately answering with JSON is not misread as a tool call.
    const message = assistant('The result is { "name": "read_file" } as requested.');

    const { toolCalls, cleanedContent } = extractPromptedToolCalls(message);

    expect(toolCalls).toHaveLength(0);
    expect(cleanedContent).toBe('The result is { "name": "read_file" } as requested.');
  });
});
