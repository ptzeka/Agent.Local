import type { ChatMessage, ToolCall, ToolDescriptor } from "./providers/provider.js";

/**
 * Tool adapter.
 *
 * Two strategies for getting tool calls out of a model:
 *
 *   - NATIVE: the model speaks Ollama/OpenAI-style function calling.
 *             The provider returns `message.toolCalls` directly. Easy mode.
 *
 *   - PROMPTED-JSON: the model can't call tools natively (e.g. deepseek-r1).
 *             We append an instruction block to the system prompt telling
 *             it to emit a fenced ```json block describing the call, and
 *             we extract those blocks from the assistant text after the fact.
 *
 * The orchestrator picks the strategy based on `provider.supportsNativeTools`.
 */

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

/**
 * Build the addendum to inject into the system prompt when the active
 * model does not support native function calling. The orchestrator
 * appends this to the existing system message at agent-loop startup.
 */
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

/**
 * Inspect an assistant message and pull out any prompted-JSON tool calls.
 * Returns the calls and a `cleanedContent` string with the JSON blocks
 * removed so it doesn't pollute the visible chat transcript.
 */
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
      // Not a valid JSON block. Leave it in the visible content so the model
      // can see its own mistake on the next turn, and skip extraction.
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

      // Strip the recognised JSON block from the visible content.
      cleaned = cleaned.replace(match[0], "").trim();
    }
  }

  // Fallback: some models (including native-tool ones that misfire) emit the
  // call as bare, unfenced JSON in prose. If the fenced pass found nothing,
  // scan for balanced top-level { … } spans and recover any that clearly look
  // like a tool call (name + arguments object). We require `arguments` here to
  // avoid misreading a model legitimately answering with JSON.
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

/**
 * Scan text for top-level, balanced `{ … }` substrings, returning each as a
 * candidate JSON string. Brace counting ignores braces inside string literals
 * and honours backslash escapes, so JSON containing `{`/`}` or quotes inside
 * values is captured whole. Nested objects are returned as part of their
 * outermost parent, not separately.
 */
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
  // For bare-JSON recovery we insist on a real arguments object so we don't
  // misread arbitrary JSON prose as a call.
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
