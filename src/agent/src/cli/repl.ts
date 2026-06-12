import readline from "node:readline/promises";
import chalk from "chalk";

import type { McpClientRegistry } from "../agent/registries/mcp-registry.js";
import type { ModelRegistry } from "../agent/registries/model-registry.js";
import type { TurnRunner } from "../agent/runners/turn-runner.js";
import type { AgentRuntime } from "../agent/runtime/agent-runtime.js";
import { renderBanner, renderEvent, renderHelp, renderSession, renderSubSessionNotification, renderTurnEvent } from "./render.js";

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
  configPath: string;
  runtime: AgentRuntime;
  resumed: boolean;
}

export async function runRepl(options: ReplOptions): Promise<void> {
  const { workspaceRoot, sandboxRoot, runtime, resumed } = options;

  const session = runtime.getSession();
  const firstUser = runtime.history().find((m) => m.role === "user");
  const preview = firstUser ? previewOf(firstUser.content) : null;

  renderBanner(
    workspaceRoot,
    sandboxRoot,
    {
      sessionId: session.sessionId,
      conversationId: session.conversationId,
      workspaceId: session.workspaceId,
      contextHashes: session.contextHashes || {} as Record<string, string>,
      resumed,
      turns: session.counters.turns,
      preview,
    },
    null
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Activity indicator + prompt repaint are CLI concerns: they hang off the
  // runner's lifecycle events here, not inside the runtime. Every writer
  // interrupts the spinner first so log lines never land on a half-drawn
  // star line.
  const spinner = new TurnSpinner(() => rl.line.length > 0);

  // Sub-session completions fire out-of-band (after the parent turn that
  // spawned them has ended). Surface them as they arrive.
  const unsubscribe = runtime.onSubSessionEvent((notification) => {
    spinner.interrupt();
    renderSubSessionNotification(notification);
  });

  // All turns flow through the runner's single pump: the REPL SUBMITS user
  // input and awaits the turn's settle, and settling sub-sessions auto-wake
  // the session through the same queue — no producer ever races the
  // dispatchAsync running-guard.
  let runnerRef: TurnRunner | null = null;
  const turnRunner = runtime.startTurnLoop({
    onEvent: (event) => {
      spinner.interrupt();
      renderEvent(event);
    },
    onTurnEvent: (event) => {
      if (event.type === "turn-start") {
        spinner.start();
        renderTurnEvent(event);
        return;
      }
      if (event.type === "turn-done") {
        spinner.stop();
        renderTurnEvent(event);
        // The pending readline question is intact — only its visual line
        // scrolled away under the turn's output. Repaint it so the user sees
        // they have the floor again; skip when another turn is about to start.
        if ((runnerRef?.pendingCount ?? 0) === 0) {
          redrawPrompt(rl);
        }
        return;
      }
      spinner.interrupt();
      renderTurnEvent(event);
    },
  });
  runnerRef = turnRunner;

  while (true) {
    let input: string;
    try {
      input = (await rl.question(chalk.bold.cyan("you> "))).trim();
    } catch {
      break;
    }

    if (input === "") continue;

    // "stop" is an interrupt, not a prompt: with the input line always live,
    // it must never enter the queue (where it would be LLM-interpreted after
    // the very work it was meant to halt).
    if (input.toLowerCase() === "stop") {
      writeStopResult(runtime.stopAllWork());
      continue;
    }

    if (input.startsWith("/")) {
      const command = input.slice(1).trim();
      const exitRequested = await handleSlashCommand(command, {
        runtime,
        turnRunner,
        registry: runtime.getModelsRegistry(),
        mcpRegistry: runtime.getMcpClientRegistry(),
        resumed,
      });
      if (exitRequested) break;
      continue;
    }

    // Fire-and-forget so the prompt stays live: typing while a turn runs is
    // how the user steers it — the input folds into the running turn as a
    // round rather than waiting behind it. Completion and failures are
    // reported by the turn-event renderer, so nothing here needs to block.
    const receipt = turnRunner.submit({ content: input, source: "user", preferMidTurn: true });
    if (receipt.placement === "mid-turn-round") {
      process.stdout.write(chalk.gray("(added to the running turn)\n"));
    }
  }

  await runtime.stopTurnLoop();
  unsubscribe();
  rl.close();

  const finalSession = runtime.getSession();
  const finalFirstUser = runtime.history().find((m) => m.role === "user");
  renderSession({
    sessionId: finalSession.sessionId,
    conversationId: finalSession.conversationId,
    workspaceId: finalSession.workspaceId,
    contextHashes: finalSession.contextHashes ?? {},
    resumed,
    turns: finalSession.counters.turns,
    preview: finalFirstUser ? previewOf(finalFirstUser.content) : null,
  });
}

// ----------------------------------------------------------------------------
// Slash commands
// ----------------------------------------------------------------------------

interface SlashContext {
  runtime: AgentRuntime;
  turnRunner: TurnRunner;
  registry: ModelRegistry;
  mcpRegistry: McpClientRegistry;
  resumed: boolean;
}

async function handleSlashCommand(command: string, ctx: SlashContext): Promise<boolean> {
  const [head, ...rest] = command.split(/\s+/);
  const args = rest.join(" ");

  switch (head) {
    case "exit":
    case "quit":
      return true;

    case "stop":
      writeStopResult(ctx.runtime.stopAllWork());
      return false;

    case "help":
      renderHelp();
      return false;

    case "session": {
      const s = ctx.runtime.getSession();
      const firstUser = ctx.runtime.history().find((m) => m.role === "user");
      renderSession({
        sessionId: s.sessionId,
        conversationId: s.conversationId,
        workspaceId: s.workspaceId,
        contextHashes: s.contextHashes ?? {},
        resumed: ctx.resumed,
        turns: s.counters.turns,
        preview: firstUser ? previewOf(firstUser.content) : null,
      });
      return false;
    }

    case "reset": {
      // The runtime stops and drains in-flight work itself; this pre-pass
      // exists only to tell the user WHAT got cancelled on their behalf.
      const stoppedForReset = ctx.runtime.stopAllWork();
      if (stoppedForReset.cancelledTurns + stoppedForReset.cancelledSubSessions > 0) {
        writeStopResult(stoppedForReset);
      }
      await ctx.runtime.reset();
      process.stdout.write(chalk.gray("(conversation cleared)\n"));
      return false;
    }

    case "compact": {
      const stoppedForCompact = ctx.runtime.stopAllWork();
      if (stoppedForCompact.cancelledTurns + stoppedForCompact.cancelledSubSessions > 0) {
        writeStopResult(stoppedForCompact);
      }
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
      await handleModelsCommand(ctx);
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

async function handleModelsCommand(ctx: SlashContext): Promise<void> {
  const config = ctx.runtime.getConfigurationRegistry();
  const modelsFile = await config.getModelsConfiguration();

  process.stdout.write(chalk.bold("\nConfigured models:\n"));
  for (const [modelId, definition] of Object.entries(modelsFile.models)) {
    const tools = definition.supportsTools ? "tools=native" : "tools=prompted";
    const reasoning = definition.reasoning ? ", reasoning" : "";
    process.stdout.write(
      `  ${chalk.cyan(modelId)} → ${definition.provider}:${definition.model} (${tools}${reasoning})\n`
    );
  }

  process.stdout.write(chalk.bold("\nRole assignments:\n"));
  for (const [role, modelId] of Object.entries(modelsFile.roles)) {
    const modelDef = modelsFile.models[modelId];
    process.stdout.write(`  ${chalk.magenta(role)} → ${modelId} (${modelDef.provider}:${modelDef.model})\n`);
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
    ctx.runtime.getModelsRegistry().assignRole(role, modelId);
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

/**
 * In-place activity indicator: cycles "*" → "****" on the current line while
 * a turn is in flight, so silent stretches (model thinking, long tool calls)
 * read as "working" rather than hung. Ticks are suppressed while the user is
 * mid-keystroke — the spinner must never clobber a line someone is typing on.
 */
class TurnSpinner {
  private timer: NodeJS.Timeout | null = null;
  private step = 0;

  constructor(private readonly userIsTyping: () => boolean) {}

  start(): void {
    if (this.timer) return;
    this.step = 0;
    this.timer = setInterval(() => {
      if (this.userIsTyping()) return;
      this.step = (this.step % 4) + 1;
      process.stdout.write("\r" + chalk.gray("*".repeat(this.step).padEnd(5)));
    }, 300);
    this.timer.unref(); // never the reason the process stays alive
  }

  /** Wipe the spinner off the current line so real output starts clean. */
  interrupt(): void {
    if (!this.timer) return;
    process.stdout.write("\r     \r");
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    process.stdout.write("\r     \r");
  }
}

/**
 * Repaint the prompt after out-of-band output. The readline question asked at
 * the top of the REPL loop is still pending — only its visual line scrolled
 * away — so this redraws the prompt plus whatever the user had already typed
 * (readline keeps the in-progress buffer on `rl.line`).
 */
function redrawPrompt(rl: readline.Interface): void {
  process.stdout.write(chalk.bold.cyan("you> ") + rl.line);
}

function writeStopResult(result: { cancelledTurns: number; cancelledSubSessions: number }): void {
  const total = result.cancelledTurns + result.cancelledSubSessions;
  process.stdout.write(
    total > 0
      ? chalk.gray(
          `(stopping everything: ${result.cancelledTurns} turn(s), ${result.cancelledSubSessions} sub-session(s))\n`
        )
      : chalk.gray("(nothing is running)\n")
  );
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
