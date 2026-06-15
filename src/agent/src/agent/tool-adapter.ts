import type { ToolDescriptor } from "@agent-local/mcp/tooldescriptor";
import type { ChatMessage, ToolCall } from "./providers/provider.js";

// prompted-JSON fallback for models without native function calling: instruct them to emit a fenced
// ```json block and extract it afterward; the orchestrator picks this vs native by supportsNativeTools
const TOOL_INSTRUCTION_HEADER =
  "When you need to use a tool, respond with a single fenced JSON block in this exact shape:";

const TOOL_INSTRUCTION_EXAMPLE = [
  "```json",
  "{",
  '  "tool_call": {',
  '    "name": "<tool name from the list above>",',
  '    "arguments": { /* arguments object matching the tool\'s input schema */ }',
  "  }",
  "}",
  "```",
].join("\n");

const TOOL_INSTRUCTION_RULES = [
  "Rules:",
  "  - Emit at most one tool_call block per turn.",
  "  - The block must be the entire content of your reply — no prose before or after.",
  "  - Once you have enough information to answer the user, reply with normal prose instead of a tool_call block.",
  "  - Never invent a tool that isn't in the list.",
].join("\n");

// the orchestrator appends this to the system message when the model lacks native function calling
export function buildPromptedToolInstructions(tools: ToolDescriptor[]): string {
  if (tools.length === 0) return "";

  const toolDescriptions = tools
    .map((tool) => {
      const schema = JSON.stringify(tool.inputSchema, null, 2);
      return `• ${tool.name} — ${tool.description}\n  arguments schema:\n${indent(schema, "  ")}`;
    })
    .join("\n\n");

  return [
    "",
    "## Available tools",
    "",
    toolDescriptions,
    "",
    "## How to invoke a tool",
    "",
    TOOL_INSTRUCTION_HEADER,
    "",
    TOOL_INSTRUCTION_EXAMPLE,
    "",
    TOOL_INSTRUCTION_RULES,
  ].join("\n");
}

// returns cleanedContent with the JSON blocks stripped so they don't pollute the visible transcript
export function extractPromptedToolCalls(message: ChatMessage): {
  toolCalls: ToolCall[];
  cleanedContent: string;
} {
  const calls: ToolCall[] = [];
  let cleaned = message.content;

  const blockPattern = /```json\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let counter = 0;

  while ((match = blockPattern.exec(message.content)) !== null) {
    const jsonText = match[1].trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      // leave an invalid block in the visible content so the model sees its own mistake next turn
      continue;
    }

    const toolCall = parseToolCallShape(parsed);
    if (toolCall) {
      calls.push({
        id: `prompted_${Date.now()}_${counter}`,
        name: toolCall.name,
        arguments: toolCall.arguments,
      });
      counter += 1;

      cleaned = cleaned.replace(match[0], "").trim();
    }
  }

  // fallback for calls emitted as bare unfenced JSON; arguments is required so we don't misread a JSON answer as a call
  if (calls.length === 0) {
    for (const candidate of extractBalancedJsonObjects(cleaned)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        continue;
      }

      const toolCall = parseToolCallShape(parsed, { requireArguments: true });
      if (toolCall) {
        calls.push({
          id: `prompted_${Date.now()}_${counter}`,
          name: toolCall.name,
          arguments: toolCall.arguments,
        });
        counter += 1;
        cleaned = cleaned.replace(candidate, "").trim();
      }
    }
  }

  return { toolCalls: calls, cleanedContent: cleaned };
}

// brace counting ignores braces inside string literals and honours escapes, so values with braces/quotes are captured whole
function extractBalancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          objects.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  return objects;
}

function parseToolCallShape(
  parsed: unknown,
  options: { requireArguments?: boolean } = {}
): { name: string; arguments: Record<string, unknown> } | null {
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  const candidate = (root.tool_call ?? root) as Record<string, unknown>;

  if (typeof candidate.name !== "string" || candidate.name.length === 0) return null;
  const args = candidate.arguments;
  const argsIsObject = typeof args === "object" && args !== null && !Array.isArray(args);

  if (args !== undefined && !argsIsObject) {
    return null;
  }
  // bare-JSON recovery insists on a real arguments object so arbitrary JSON prose isn't misread as a call
  if (options.requireArguments && !argsIsObject) {
    return null;
  }

  return {
    name: candidate.name,
    arguments: (args ?? {}) as Record<string, unknown>,
  };
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
