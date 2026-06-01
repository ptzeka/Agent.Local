import readline from "node:readline/promises";
import chalk from "chalk";

import type { McpToolClient } from "../agent/mcp-client.js";
import type { ModelRegistry } from "../agent/model-registry.js";
import type { ProjectContext } from "../agent/context-loader.js";
import { Orchestrator } from "../agent/orchestrator.js";

import { renderBanner, renderEvent, renderHelp } from "./render.js";

/**
 * Interactive REPL.
 *
 * Wraps the orchestrator with a readline prompt and a small set of slash
 * commands. The REPL itself contains no model or tool logic — it only
 * routes user input into the orchestrator and routes events back out
 * through the renderer.
 */

export interface ReplOptions {
  workspaceRoot: string;
  registry: ModelRegistry;
  tools: McpToolClient;
  projectContext?: ProjectContext | null;
}

export async function runRepl(options: ReplOptions): Promise<void> {
  const { workspaceRoot, registry, tools, projectContext = null } = options;
  const orchestrator = new Orchestrator(registry, tools, projectContext);

  let usePlannerForNextTurn = registry.orchestration.planFirst;

  renderBanner(workspaceRoot, usePlannerForNextTurn, projectContext?.sourcePath ?? null);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  while (true) {
    const promptLabel = usePlannerForNextTurn
      ? chalk.bold.cyan("you (plan→exec)> ")
      : chalk.bold.magenta("you (exec)> ");

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
        orchestrator,
        registry,
        tools,
        getThinkSetting: () => usePlannerForNextTurn,
        setThinkSetting: (next) => {
          usePlannerForNextTurn = next;
        },
      });
      if (exitRequested) break;
      continue;
    }

    try {
      await orchestrator.run(input, {
        usePlanner: usePlannerForNextTurn,
        onEvent: renderEvent,
      });
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
  orchestrator: Orchestrator;
  registry: ModelRegistry;
  tools: McpToolClient;
  getThinkSetting: () => boolean;
  setThinkSetting: (next: boolean) => void;
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

    case "reset":
      ctx.orchestrator.reset();
      process.stdout.write(chalk.gray("(conversation cleared)\n"));
      return false;

    case "think":
      handleThinkCommand(args, ctx);
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

function handleThinkCommand(args: string, ctx: SlashContext): void {
  const value = args.trim().toLowerCase();
  if (value === "on") {
    ctx.setThinkSetting(true);
    process.stdout.write(chalk.gray("(planner phase: on)\n"));
  } else if (value === "off") {
    ctx.setThinkSetting(false);
    process.stdout.write(chalk.gray("(planner phase: off)\n"));
  } else {
    const current = ctx.getThinkSetting() ? "on" : "off";
    process.stdout.write(chalk.gray(`planner phase is currently ${current}. usage: /think on|off\n`));
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
  const history = ctx.orchestrator.history();
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
