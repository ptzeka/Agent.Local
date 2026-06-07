import readline from "node:readline/promises";
import chalk from "chalk";

import type { McpToolClient } from "../agent/mcp-client.js";
import type { ModelRegistry } from "../agent/model-registry.js";
import type { ProjectContext } from "../agent/context-loader.js";
import type { Initializer } from "../agent/initializer.js";

import { renderBanner, renderEvent, renderHelp } from "./render.js";

/**
 * Interactive REPL.
 *
 * Wraps a single session with a readline prompt and a small set of slash
 * commands. The REPL itself contains no model or tool logic — it only
 * routes user input into the initializer (addressed by sessionId) and
 * routes events back out through the renderer.
 */

export interface ReplOptions {
  workspaceRoot: string;
  /** The fs tool sandbox root — where all fsmcp file I/O is confined. */
  sandboxRoot: string;
  registry: ModelRegistry;
  tools: McpToolClient;
  /** The stateful session owner that drives the orchestrator. */
  initializer: Initializer;
  /** The session this REPL drives — every action is addressed to it. */
  sessionId: string;
  projectContext?: ProjectContext | null;
}

export async function runRepl(options: ReplOptions): Promise<void> {
  const { workspaceRoot, sandboxRoot, registry, tools, initializer, sessionId, projectContext = null } = options;

  renderBanner(workspaceRoot, sandboxRoot, projectContext?.sourcePath ?? null);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  while (true) {
    const promptLabel = chalk.bold.cyan("you> ");

    let input: string;
    try {
      input = (await rl.question(promptLabel)).trim();
    } catch {
      // Reading was aborted (e.g. Ctrl+C at the prompt). Exit cleanly.
      break;
    }

    if (input === "") continue;

    if (input.startsWith("/")) {
      const command = input.slice(1).trim();
      const exitRequested = await handleSlashCommand(command, {
        initializer,
        sessionId,
        registry,
        tools,
      });
      if (exitRequested) break;
      continue;
    }

    try {
      await initializer.dispatch(sessionId, input, { onEvent: renderEvent });
    } catch (err) {
      process.stdout.write(chalk.red(`\n[error] ${(err as Error).message}\n`));
    }
  }

  rl.close();
}

// ----------------------------------------------------------------------------
// Slash commands
// ----------------------------------------------------------------------------

interface SlashContext {
  initializer: Initializer;
  sessionId: string;
  registry: ModelRegistry;
  tools: McpToolClient;
}

/**
 * Returns true if the REPL should exit.
 */
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
      const result = await ctx.initializer.reset(ctx.sessionId);
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
        const result = await ctx.initializer.compact(ctx.sessionId);
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
      // The planner phase no longer exists. Accept the command so old muscle
      // memory doesn't error out, but report the new architecture.
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
  const tools = ctx.tools.listTools();
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
  const history = ctx.initializer.history(ctx.sessionId);
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

function roleColour(role: string): (s: string) => string {
  switch (role) {
    case "user":
      return chalk.bold.white;
    case "assistant":
      return chalk.magenta;
    case "tool":
      return chalk.green;
    case "system":
      return chalk.gray;
    default:
      return chalk.white;
  }
}
