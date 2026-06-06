import type { McpToolClient, ToolExecutionResult } from "./mcp-client.js";
import type {
  ChatMessage,
  ChatResponse,
  LLMProvider,
  ToolCall,
  ToolDescriptor,
} from "./providers/provider.js";
import {
  buildPromptedToolInstructions,
  extractPromptedToolCalls,
} from "./tool-adapter.js";
import { EXECUTOR_SYSTEM_PROMPT } from "./system-prompt.js";

/**
 * Executor sub-agent.
 *
 * The orchestrator hands a single ask (tool + args + intent) to `run()`.
 * Inside, a short bounded LLM conversation drives the executor through
 * its mandatory four-step shape:
 *
 *   1. ACK <tool>
 *   2. call the requested tool
 *   3. independently re-read or check exit code to validate
 *   4. RESULT OK | FAIL  + evidence
 *
 * After the LLM finishes, a deterministic post-step verifies reality on
 * disk (or by tool-result inspection for exec-style tools). If the
 * deterministic check disagrees with the LLM's verdict, the deterministic
 * verdict wins — the orchestrator is told so explicitly.
 */

export interface ExecutorAsk {
  tool: string;
  args: Record<string, unknown>;
  intent: string;
}

export interface ExecutorEvent {
  type:
    | "executor-start"
    | "executor-ack"
    | "executor-tool-call"
    | "executor-tool-result"
    | "executor-validate"
    | "executor-report"
    | "executor-deterministic-verdict"
    | "executor-warning";
  data: Record<string, unknown>;
}

export type ExecutorListener = (event: ExecutorEvent) => void;

export interface ExecutorFeedback {
  ok: boolean;
  ack: string | null;
  llmReport: string | null;
  evidence: string;
  deterministicVerdict: "ok" | "mismatch" | "unverified";
  /** Full sub-conversation, useful for debugging and surfacing in the REPL. */
  transcript: ChatMessage[];
  /** Iteration count actually consumed inside the executor's loop. */
  iterations: number;
}

export interface ExecutorRunOptions {
  signal?: AbortSignal;
  onEvent?: ExecutorListener;
  /** Hard cap on executor LLM iterations. Defaults to 6. */
  maxIterations?: number;
  /** Sampling temperature for the executor LLM. Defaults to 0.1. */
  temperature?: number;
}

const DEFAULT_MAX_ITERATIONS = 6;
const DEFAULT_TEMPERATURE = 0.1;

export class Executor {
  constructor(
    private readonly provider: LLMProvider,
    private readonly tools: McpToolClient,
    private readonly availableTools: ToolDescriptor[]
  ) {}

  public async run(ask: ExecutorAsk, options: ExecutorRunOptions = {}): Promise<ExecutorFeedback> {
    const emit = options.onEvent ?? (() => {});
    const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

    emit({
      type: "executor-start",
      data: {
        model: this.provider.modelId,
        provider: this.provider.providerName,
        tool: ask.tool,
        intent: ask.intent,
      },
    });

    // Sanity-check the ask up front. If the requested tool isn't in the
    // executor's allowed set, there's no point spinning up the LLM.
    const allowedNames = new Set(this.availableTools.map((t) => t.name));
    if (!allowedNames.has(ask.tool)) {
      const evidence = `requested tool "${ask.tool}" is not in the executor's tool list`;
      emit({ type: "executor-warning", data: { reason: evidence } });
      return {
        ok: false,
        ack: null,
        llmReport: null,
        evidence,
        deterministicVerdict: "mismatch",
        transcript: [],
        iterations: 0,
      };
    }

    const systemMessages = this.buildSystemMessages();
    const askMessage: ChatMessage = {
      role: "user",
      content: this.formatAskAsUserMessage(ask),
    };

    const workingMessages: ChatMessage[] = [...systemMessages, askMessage];

    let ack: string | null = null;
    let llmReport: string | null = null;
    let mainToolResult: ToolExecutionResult | null = null;
    let iterations = 0;

    for (let i = 1; i <= maxIterations; i += 1) {
      iterations = i;

      const response = await this.provider.chat(workingMessages, {
        tools: this.provider.supportsNativeTools ? this.availableTools : [],
        temperature,
        signal: options.signal,
      });

      const { assistantMessage, toolCalls } = this.normaliseAssistantTurn(response);
      workingMessages.push(assistantMessage);

      // Capture the ACK line the first time it appears.
      if (ack === null) {
        const parsedAck = parseAckLine(assistantMessage.content);
        if (parsedAck) {
          ack = parsedAck;
          emit({ type: "executor-ack", data: { ack: parsedAck } });
        }
      }

      // If the assistant emitted RESULT, we treat this as the final report.
      const parsedReport = parseResultLine(assistantMessage.content);
      if (parsedReport) {
        llmReport = assistantMessage.content;
        emit({
          type: "executor-report",
          data: { verdict: parsedReport.verdict, message: parsedReport.message },
        });
        break;
      }

      // Otherwise dispatch any tool calls and append the results.
      if (toolCalls.length === 0) {
        // No tool calls, no RESULT — protocol drift. Inject a steering message
        // and let the model try again on the next iteration.
        workingMessages.push({
          role: "user",
          content:
            "EXECUTOR protocol reminder: emit either a tool call or a final " +
            "`EXECUTOR: RESULT OK ...` / `EXECUTOR: RESULT FAIL ...` line.",
        });
        emit({
          type: "executor-warning",
          data: { reason: "no tool call and no RESULT line", iteration: i },
        });
        continue;
      }

      for (const call of toolCalls) {
        const isMainAsk = call.name === ask.tool && argsRoughlyMatch(call.arguments, ask.args);

        emit({
          type: isMainAsk ? "executor-tool-call" : "executor-validate",
          data: { id: call.id, name: call.name, arguments: call.arguments },
        });

        const execution = await this.tools.callTool(call.name, call.arguments);

        emit({
          type: "executor-tool-result",
          data: {
            id: call.id,
            name: call.name,
            isError: execution.isError,
            contentPreview: execution.content.slice(0, 300),
          },
        });

        if (isMainAsk && mainToolResult === null) {
          mainToolResult = execution;
        }

        workingMessages.push({
          role: "tool",
          content: execution.isError ? `[tool-error] ${execution.content}` : execution.content,
          toolCallId: call.id,
          toolName: call.name,
        });
      }
    }

    // Deterministic post-step. This is what makes the protocol enforceable.
    const verification = await this.verify(ask, mainToolResult);

    emit({
      type: "executor-deterministic-verdict",
      data: { verdict: verification.verdict, evidence: verification.evidence },
    });

    const llmSaysOk = llmReport ? parseResultLine(llmReport)?.verdict === "OK" : false;
    const ok = verification.verdict === "mismatch" ? false : llmSaysOk;

    return {
      ok,
      ack,
      llmReport,
      evidence: verification.evidence,
      deterministicVerdict: verification.verdict,
      transcript: workingMessages,
      iterations,
    };
  }

  // --------------------------------------------------------------------------

  private buildSystemMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: "system", content: EXECUTOR_SYSTEM_PROMPT }];

    if (!this.provider.supportsNativeTools) {
      messages.push({
        role: "system",
        content: buildPromptedToolInstructions(this.availableTools),
      });
    }

    return messages;
  }

  private formatAskAsUserMessage(ask: ExecutorAsk): string {
    return [
      "ORCHESTRATOR: dispatch",
      `  tool:   ${ask.tool}`,
      `  intent: ${ask.intent}`,
      "  args:",
      indent(JSON.stringify(ask.args, null, 2), "    "),
      "",
      "Follow the EXECUTOR protocol: ACK, execute, validate, RESULT.",
    ].join("\n");
  }

  private normaliseAssistantTurn(response: ChatResponse): {
    assistantMessage: ChatMessage;
    toolCalls: ToolCall[];
  } {
    if (this.provider.supportsNativeTools) {
      const native = response.message.toolCalls ?? [];
      if (native.length > 0) {
        return { assistantMessage: response.message, toolCalls: native };
      }
      const { toolCalls, cleanedContent } = extractPromptedToolCalls(response.message);
      if (toolCalls.length > 0) {
        return {
          assistantMessage: { role: "assistant", content: cleanedContent, toolCalls },
          toolCalls,
        };
      }
      return { assistantMessage: response.message, toolCalls: [] };
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

  /**
   * Deterministic post-step. We verify reality on disk where we can, and
   * fall back to "unverified" when we can't (e.g. a free-form shell command
   * with no specific assertion). "unverified" is not a failure — it means
   * we defer to the LLM's RESULT line. "mismatch" overrides the LLM.
   */
  private async verify(
    ask: ExecutorAsk,
    mainToolResult: ToolExecutionResult | null
  ): Promise<{ verdict: "ok" | "mismatch" | "unverified"; evidence: string }> {
    if (mainToolResult === null) {
      return {
        verdict: "mismatch",
        evidence: `executor never called the requested tool "${ask.tool}"`,
      };
    }

    if (mainToolResult.isError) {
      return {
        verdict: "mismatch",
        evidence: `requested tool "${ask.tool}" returned an error: ${mainToolResult.content.slice(0, 200)}`,
      };
    }

    const kind = classifyTool(ask.tool);

    if (kind === "write_file") {
      const path = typeof ask.args.path === "string" ? ask.args.path : null;
      const expected = typeof ask.args.content === "string" ? ask.args.content : null;
      if (!path || expected === null) {
        return { verdict: "unverified", evidence: "write_file ask missing path or content" };
      }
      const readBack = await this.readFileForVerification(path);
      if (readBack === null) {
        return { verdict: "mismatch", evidence: `post-write read of "${path}" failed` };
      }
      if (readBack !== expected) {
        return {
          verdict: "mismatch",
          evidence: `post-write read of "${path}" does not match requested content`,
        };
      }
      return { verdict: "ok", evidence: `wrote ${expected.length} chars to "${path}"` };
    }

    if (kind === "edit_file") {
      const path = typeof ask.args.path === "string" ? ask.args.path : null;
      const expectedSubstring = pickExpectedSubstring(ask.args);
      if (!path) {
        return { verdict: "unverified", evidence: "edit_file ask missing path" };
      }
      const readBack = await this.readFileForVerification(path);
      if (readBack === null) {
        return { verdict: "mismatch", evidence: `post-edit read of "${path}" failed` };
      }
      if (expectedSubstring && !readBack.includes(expectedSubstring)) {
        return {
          verdict: "mismatch",
          evidence: `post-edit read of "${path}" does not contain expected replacement`,
        };
      }
      return {
        verdict: "ok",
        evidence: expectedSubstring
          ? `edit landed in "${path}" (replacement substring present)`
          : `edit completed on "${path}" (no substring assertion possible)`,
      };
    }

    if (kind === "exec") {
      return {
        verdict: "ok",
        evidence: `shell tool returned without isError; output ${mainToolResult.content.length} chars`,
      };
    }

    return {
      verdict: "unverified",
      evidence: `tool "${ask.tool}" has no deterministic verifier; trusting LLM RESULT`,
    };
  }

  private async readFileForVerification(path: string): Promise<string | null> {
    const readToolName = this.availableTools
      .map((t) => t.name)
      .find((name) => name.endsWith("__read_file"));
    if (!readToolName) return null;

    const result = await this.tools.callTool(readToolName, { path });
    if (result.isError) return null;
    return result.content;
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseAckLine(content: string): string | null {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    const match = line.match(/^EXECUTOR:\s*ACK\s+(.+)$/);
    if (match) return match[1].trim();
  }
  return null;
}

function parseResultLine(content: string): { verdict: "OK" | "FAIL"; message: string } | null {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    const match = line.match(/^EXECUTOR:\s*RESULT\s+(OK|FAIL)\b\s*(.*)$/);
    if (match) {
      return { verdict: match[1] as "OK" | "FAIL", message: match[2].trim() };
    }
  }
  return null;
}

function classifyTool(name: string): "write_file" | "edit_file" | "exec" | "other" {
  const tail = name.split("__").pop() ?? name;
  if (tail === "write_file") return "write_file";
  if (tail === "edit_file") return "edit_file";
  if (tail === "exec" || tail === "shell" || tail === "powershell" || tail === "run_command") {
    return "exec";
  }
  return "other";
}

function pickExpectedSubstring(args: Record<string, unknown>): string | null {
  // edit_file shapes vary across MCP servers. Try common field names in order.
  for (const key of ["newText", "replacement", "new_string", "content"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function argsRoughlyMatch(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  // We don't require deep equality — the executor may add or reorder fields.
  // For the "main ask" identification we only need the primary identifier
  // (usually `path`, falling back to command/cwd) to agree.
  for (const key of ["path", "command", "cwd"]) {
    if (key in b) {
      if (a[key] !== b[key]) return false;
    }
  }
  return true;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
