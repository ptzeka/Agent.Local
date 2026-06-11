import readline from "node:readline/promises";
import chalk from "chalk";

import type { McpClientRegistry } from "../agent/registries/mcp-registry.js";
import type { ModelRegistry } from "../agent/registries/model-registry.js";
import type { AgentRuntime } from "../agent/runtime/agent-runtime.js";

import { renderBanner, renderEvent, renderHelp, renderSubSessionNotification } from "./render.js";

/**
 * Interactive REPL.
 *
 * Wraps a single session's AgentRuntime with a readline prompt and a small set
 * of slash commands. All model and tool logic lives in the runtime — the REPL
 * only routes input in and events out.
 */

export interface ReplOptions {
  workspaceRoot: string;
  sandboxRoot: string;
  registry: ModelRegistry;
  mcpRegistry: McpClientRegistry;
  runtime: AgentRuntime;
  resumed: boolean;
}

export async function runRepl(options: ReplOptions): Promise<void> {
  const { workspaceRoot, sandboxRoot, registry, mcpRegistry, runtime, resumed } = options;

  const session = runtime.getSession();
  const firstUser = session.conversation.find((m) => m.role === "user");
  const preview = firstUser ? previewOf(firstUser.content) : null;

  renderBanner(
    workspaceRoot,
    sandboxRoot,
    {
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      contextHashes: session.contextHashes || {} as Record<string, string>,
      resumed,
      turns: session.counters.turns,
      preview,
    },
    runtime.getWorkspaceContext()?.sourcePath ?? null
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Sub-session completions fire out-of-band (after the parent turn that
  // spawned them has ended). Surface them as they arrive.
  const unsubscribe = runtime.onSubSessionEvent(renderSubSessionNotification);

  while (true) {
    let input: string;
    try {
      input = (await rl.question(chalk.bold.cyan("you> "))).trim();
    } catch {
      break;
    }

    if (input === "") continue;

    if (input.startsWith("/")) {
      const command = input.slice(1).trim();
      const exitRequested = await handleSlashCommand(command, { runtime, registry, mcpRegistry });
      if (exitRequested) break;
      continue;
    }

    try {
      await runtime.dispatchAsync(input, { onEvent: renderEvent });
    } catch (err) {
      const error = err as Error;
      process.stdout.write(chalk.red(`\n[error] repl: ${error.message}\n`));
      if (error.cause) {
        process.stdout.write(chalk.red(`  cause: ${error.cause}\n`));
      }
      if (process.env.DEBUG) {
        process.stdout.write(chalk.gray(`  stack: ${error.stack}\n`));
      }
    }
  }

  unsubscribe();
  rl.close();
}

// ----------------------------------------------------------------------------
// Slash commands
// ----------------------------------------------------------------------------

interface SlashContext {
  runtime: AgentRuntime;
  registry: ModelRegistry;
  mcpRegistry: McpClientRegistry;
}

async function handleSlashCommand(command: string, ctx: SlashContext): Promise<boolean> {
  const [head, ...rest] = command.split(/\s+/);
  const args = rest.join(" ");

  switch (head) {
    case "exit":
    case "quit":
      return true;

    case "help":
      renderHelp();
      return false;

    case "reset": {
      const result = await ctx.runtime.reset();
      const contextNote = result.context
        ? `context reloaded from ${result.context.sourcePath}` +
          (result.contextChanged ? " (changed)" : " (unchanged)")
        : "no project context file";
      process.stdout.write(chalk.gray(`(conversation cleared; ${contextNote})\n`));
      return false;
    }

    case "compact": {
      process.stdout.write(chalk.gray("(summarizing…)\n"));
      try {
        const result = await ctx.runtime.compact();
        if (result.skipped) {
          process.stdout.write(chalk.gray("(nothing to compact)\n"));
        } else {
          process.stdout.write(`\n${chalk.bold.gray("[SUMMARY]")}\n${result.summary}\n`);
          process.stdout.write(
            chalk.gray(`\n(compacted ${result.summarizedCount} messages into a summary checkpoint)\n`)
          );
        }
      } catch (err) {
        process.stdout.write(chalk.red(`error: ${(err as Error).message}\n`));
      }
      return false;
    }

    case "think":
      process.stdout.write(
        chalk.gray(
          "(/think is gone — the orchestrator coordinates every turn and dispatches the executor as needed)\n"
        )
      );
      return false;

    case "models":
      handleModelsCommand(ctx);
      return false;

    case "model":
      handleModelAssignmentCommand(args, ctx);
      return false;

    case "tools":
      handleToolsCommand(ctx);
      return false;

    case "history":
      handleHistoryCommand(ctx);
      return false;

    default:
      process.stdout.write(chalk.yellow(`unknown command: /${head} (try /help)\n`));
      return false;
  }
}

function handleModelsCommand(ctx: SlashContext): void {
  process.stdout.write(chalk.bold("\nConfigured models:\n"));
  for (const entry of ctx.registry.listModels()) {
    const tools = entry.definition.supportsTools ? "tools=native" : "tools=prompted";
    const reasoning = entry.definition.reasoning ? ", reasoning" : "";
    process.stdout.write(
      `  ${chalk.cyan(entry.id)} → ${entry.definition.provider}:${entry.definition.model} (${tools}${reasoning})\n`
    );
  }
  process.stdout.write(chalk.bold("\nRole assignments:\n"));
  for (const entry of ctx.registry.listRoles()) {
    process.stdout.write(`  ${chalk.magenta(entry.role)} → ${entry.modelId} (${entry.provider.modelId})\n`);
  }
  process.stdout.write("\n");
}

function handleModelAssignmentCommand(args: string, ctx: SlashContext): void {
  const match = /^([a-zA-Z0-9_-]+)\s*=\s*([a-zA-Z0-9_:.-]+)$/.exec(args.trim());
  if (!match) {
    process.stdout.write(chalk.yellow("usage: /model <role>=<model-id>\n"));
    return;
  }

  const [, role, modelId] = match;
  try {
    ctx.registry.assignRole(role, modelId);
    process.stdout.write(chalk.gray(`(role "${role}" now uses "${modelId}")\n`));
  } catch (err) {
    process.stdout.write(chalk.red(`error: ${(err as Error).message}\n`));
  }
}

function handleToolsCommand(ctx: SlashContext): void {
  const tools = ctx.mcpRegistry.listTools();
  if (tools.length === 0) {
    process.stdout.write(chalk.yellow("(no tools connected)\n"));
    return;
  }
  process.stdout.write(chalk.bold(`\nConnected tools (${tools.length}):\n`));
  for (const tool of tools) {
    process.stdout.write(`  ${chalk.green(tool.name)} — ${tool.description}\n`);
  }
  process.stdout.write("\n");
}

function handleHistoryCommand(ctx: SlashContext): void {
  const history = ctx.runtime.history();
  if (history.length === 0) {
    process.stdout.write(chalk.gray("(empty)\n"));
    return;
  }
  process.stdout.write(chalk.bold("\nConversation so far:\n"));
  for (const message of history) {
    const label = message.role.padEnd(9);
    const colour = roleColour(message.role);
    process.stdout.write(`  ${colour(label)} ${message.content}\n`);
  }
  process.stdout.write("\n");
}

function previewOf(content: string): string | null {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

function roleColour(role: string): (s: string) => string {
  switch (role) {
    case "user":      return chalk.bold.white;
    case "assistant": return chalk.magenta;
    case "tool":      return chalk.green;
    case "system":    return chalk.gray;
    default:          return chalk.white;
  }
}
