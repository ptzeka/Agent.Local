import readline from "node:readline/promises";
import { clearLine, cursorTo, moveCursor } from "node:readline";
import chalk from "chalk";

import type { McpClientRegistry } from "../agent/registries/mcp-registry.js";
import type { ModelRegistry } from "../agent/registries/model-registry.js";
import type { TurnRunner } from "../agent/runners/turn-runner.js";
import type { AgentRuntime } from "../agent/runtime/agent-runtime.js";
import { formatEvent, formatSubSessionNotification, formatTurnEvent, renderBanner, renderHelp, renderSession, type BannerSession } from "./render.js";

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

const PROMPT = chalk.bold.cyan("you> ");

export async function runRepl(options: ReplOptions): Promise<void> {
  const { workspaceRoot, sandboxRoot, runtime, resumed } = options;

  renderBanner(workspaceRoot, sandboxRoot, bannerSessionOf(runtime, resumed), null);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT,
  });

  // Single owner of terminal layout: the prompt is pinned to the bottom row and
  // every out-of-band line (turn output, spinner, sub-session reports) is
  // written ABOVE it, then the prompt + in-progress input are repainted
  // beneath. Without this, streamed writes land on top of readline's prompt row
  // and smear whatever the user is mid-typing.
  const ui = new PromptUI(rl);

  // Activity indicator: draws a transient status line directly above the
  // prompt while a turn is in flight, suppressed while the user is mid-keystroke
  // so it never fights live typing.
  const spinner = new TurnSpinner(ui, () => rl.line.length > 0);

  // Sub-session completions fire out-of-band (after the parent turn that
  // spawned them has ended). Surface them as they arrive, above the prompt.
  const unsubscribe = runtime.onSubSessionEvent((notification) => {
    ui.write(formatSubSessionNotification(notification));
  });

  // All turns flow through the runner's single pump: the REPL SUBMITS user
  // input fire-and-forget (the prompt never blocks), and settling sub-sessions
  // auto-wake the session through the same queue — no producer ever races the
  // dispatchAsync running-guard.
  const turnRunner = runtime.startTurnLoop({
    onEvent: (event) => {
      ui.write(formatEvent(event));
    },
    onTurnEvent: (event) => {
      if (event.type === "turn-start") {
        ui.write(formatTurnEvent(event));
        spinner.start();
        return;
      }
      if (event.type === "turn-done") {
        spinner.stop();
        ui.write(formatTurnEvent(event));
        return;
      }
      ui.write(formatTurnEvent(event));
    },
  });

  const ctx: SlashContext = {
    runtime,
    turnRunner,
    registry: runtime.getModelsRegistry(),
    mcpRegistry: runtime.getMcpClientRegistry(),
    resumed,
    write: (text) => ui.write(text),
  };

  // Event-driven input: readline keeps the prompt live and repaintable. A
  // `while (await rl.question())` loop can't be repainted mid-question (the
  // question prompt isn't the interface's configured prompt), so the bottom bar
  // would scroll away — the `line` event + `prompt(true)` is what keeps it
  // pinned.
  await new Promise<void>((resolve) => {
    const finish = () => {
      rl.off("line", onLine);
      resolve();
    };

    const onLine = (raw: string) => {
      const input = raw.trim();
      if (input === "") {
        rl.prompt(true);
        return;
      }

      // "stop" is an interrupt, not a prompt: with the input line always live,
      // it must never enter the queue (where it would be LLM-interpreted after
      // the very work it was meant to halt).
      if (input.toLowerCase() === "stop") {
        ui.write(stopResultText(runtime.stopAllWork()));
        rl.prompt(true);
        return;
      }

      if (input.startsWith("/")) {
        void handleSlashCommand(input.slice(1).trim(), ctx).then((exitRequested) => {
          if (exitRequested) {
            finish();
            return;
          }
          rl.prompt(true);
        });
        return;
      }

      // Fire-and-forget so the prompt stays live: typing while a turn runs is
      // how the user steers it — the input folds into the running turn as a
      // round rather than waiting behind it. Completion and failures are
      // reported by the turn-event renderer, so nothing here needs to block.
      const receipt = turnRunner.submit({ content: input, source: "user", preferMidTurn: true });
      if (receipt.placement === "mid-turn-round") {
        ui.write(chalk.gray("(added to the running turn)\n"));
      }
      rl.prompt(true);
    };

    rl.on("line", onLine);
    rl.once("close", finish);
    rl.prompt();
  });

  await runtime.stopTurnLoop();
  unsubscribe();
  rl.close();

  renderSession(bannerSessionOf(runtime, resumed));
}

/**
 * Assemble the identity line's data from a live runtime. Shared by the REPL
 * (banner, /session, exit) and the headless run's exit summary so every mode
 * reports the session the same way.
 */
export function bannerSessionOf(runtime: AgentRuntime, resumed: boolean): BannerSession {
  const session = runtime.getSession();
  const firstUser = runtime.history().find((m) => m.role === "user");
  return {
    sessionId: session.sessionId,
    conversationId: session.conversationId,
    workspaceId: session.workspaceId,
    contextHashes: session.contextHashes ?? {},
    resumed,
    turns: session.counters.turns,
    preview: firstUser ? previewOf(firstUser.content) : null,
  };
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
  /** Output sink — routes through the pinned-prompt writer so command output
   *  never collides with the live bottom bar. */
  write: (text: string) => void;
}

async function handleSlashCommand(command: string, ctx: SlashContext): Promise<boolean> {
  const [head, ...rest] = command.split(/\s+/);
  const args = rest.join(" ");

  switch (head) {
    case "exit":
    case "quit":
      return true;

    case "stop":
      ctx.write(stopResultText(ctx.runtime.stopAllWork()));
      return false;

    case "help":
      renderHelp(ctx.write);
      return false;

    case "session": {
      renderSession(bannerSessionOf(ctx.runtime, ctx.resumed), ctx.write);
      return false;
    }

    case "reset": {
      // The runtime stops and drains in-flight work itself; this pre-pass
      // exists only to tell the user WHAT got cancelled on their behalf.
      const stoppedForReset = ctx.runtime.stopAllWork();
      if (stoppedForReset.cancelledTurns + stoppedForReset.cancelledSubSessions > 0) {
        ctx.write(stopResultText(stoppedForReset));
      }
      await ctx.runtime.reset();
      ctx.write(chalk.gray("(conversation cleared)\n"));
      return false;
    }

    case "compact": {
      const stoppedForCompact = ctx.runtime.stopAllWork();
      if (stoppedForCompact.cancelledTurns + stoppedForCompact.cancelledSubSessions > 0) {
        ctx.write(stopResultText(stoppedForCompact));
      }
      ctx.write(chalk.gray("(summarizing…)\n"));
      try {
        const result = await ctx.runtime.compact();
        if (result.skipped) {
          ctx.write(chalk.gray("(nothing to compact)\n"));
        } else {
          ctx.write(`\n${chalk.bold.gray("[SUMMARY]")}\n${result.summary}\n`);
          ctx.write(
            chalk.gray(`\n(compacted ${result.summarizedCount} messages into a summary checkpoint)\n`)
          );
        }
      } catch (err) {
        ctx.write(chalk.red(`error: ${(err as Error).message}\n`));
      }
      return false;
    }

    case "think":
      ctx.write(
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
      ctx.write(chalk.yellow(`unknown command: /${head} (try /help)\n`));
      return false;
  }
}

async function handleModelsCommand(ctx: SlashContext): Promise<void> {
  const config = ctx.runtime.getConfigurationRegistry();
  const modelsFile = await config.getModelsConfiguration();

  let out = chalk.bold("\nConfigured models:\n");
  for (const [modelId, definition] of Object.entries(modelsFile.models)) {
    const tools = definition.supportsTools ? "tools=native" : "tools=prompted";
    const reasoning = definition.reasoning ? ", reasoning" : "";
    out += `  ${chalk.cyan(modelId)} → ${definition.provider}:${definition.model} (${tools}${reasoning})\n`;
  }

  out += chalk.bold("\nRole assignments:\n");
  for (const [role, modelId] of Object.entries(modelsFile.roles)) {
    const modelDef = modelsFile.models[modelId];
    out += `  ${chalk.magenta(role)} → ${modelId} (${modelDef.provider}:${modelDef.model})\n`;
  }
  ctx.write(out + "\n");
}

function handleModelAssignmentCommand(args: string, ctx: SlashContext): void {
  const match = /^([a-zA-Z0-9_-]+)\s*=\s*([a-zA-Z0-9_:.-]+)$/.exec(args.trim());
  if (!match) {
    ctx.write(chalk.yellow("usage: /model <role>=<model-id>\n"));
    return;
  }

  const [, role, modelId] = match;
  try {
    ctx.runtime.getModelsRegistry().assignRole(role, modelId);
    ctx.write(chalk.gray(`(role "${role}" now uses "${modelId}")\n`));
  } catch (err) {
    ctx.write(chalk.red(`error: ${(err as Error).message}\n`));
  }
}

function handleToolsCommand(ctx: SlashContext): void {
  const tools = ctx.mcpRegistry.listTools();
  if (tools.length === 0) {
    ctx.write(chalk.yellow("(no tools connected)\n"));
    return;
  }
  let out = chalk.bold(`\nConnected tools (${tools.length}):\n`);
  for (const tool of tools) {
    out += `  ${chalk.green(tool.name)} — ${tool.description}\n`;
  }
  ctx.write(out + "\n");
}

function handleHistoryCommand(ctx: SlashContext): void {
  const history = ctx.runtime.history();
  if (history.length === 0) {
    ctx.write(chalk.gray("(empty)\n"));
    return;
  }
  let out = chalk.bold("\nConversation so far:\n");
  for (const message of history) {
    const label = message.role.padEnd(9);
    const colour = roleColour(message.role);
    out += `  ${colour(label)} ${message.content}\n`;
  }
  ctx.write(out + "\n");
}

/**
 * Owns terminal layout so the `you>` prompt stays pinned to the bottom row.
 * The invariant: the cursor rests on the prompt row, and at most one transient
 * status line (the spinner) sits on the row directly above it. Both `write`
 * (completed output) and `status` (spinner) clear that region first, emit their
 * text where the region was, then repaint the prompt + in-progress input
 * beneath — so streamed output scrolls up and the input line never gets smeared.
 */
class PromptUI {
  private statusVisible = false;

  constructor(private readonly rl: readline.Interface) {}

  /** Emit completed output above the prompt. No-op on empty strings so the
   *  many "renders nothing" event cases don't churn the prompt. */
  write(text: string): void {
    if (text.length === 0) return;
    this.clearRegion();
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
    this.rl.prompt(true);
  }

  /** Draw/refresh the transient status line directly above the prompt. */
  status(text: string): void {
    this.clearRegion();
    process.stdout.write(text + "\n");
    this.statusVisible = true;
    this.rl.prompt(true);
  }

  /** Remove the status line, if any, and repaint the prompt. */
  clearStatus(): void {
    if (!this.statusVisible) return;
    this.clearRegion();
    this.rl.prompt(true);
  }

  /**
   * Clear the prompt row and, when a status line is showing on the row above,
   * that row too — leaving the cursor at column 0 of the topmost cleared row,
   * ready for fresh content. Callers always repaint the prompt afterwards.
   */
  private clearRegion(): void {
    cursorTo(process.stdout, 0);
    clearLine(process.stdout, 0);
    if (this.statusVisible) {
      moveCursor(process.stdout, 0, -1);
      clearLine(process.stdout, 0);
      this.statusVisible = false;
    }
  }
}

/**
 * In-place activity indicator: cycles "*" → "****" on a status line just above
 * the pinned prompt while a turn is in flight, so silent stretches (model
 * thinking, long tool calls) read as "working" rather than hung. Ticks are
 * suppressed while the user is mid-keystroke — repainting the prompt under live
 * typing is harmless, but skipping spares needless flicker.
 */
class TurnSpinner {
  private timer: NodeJS.Timeout | null = null;
  private step = 0;

  constructor(
    private readonly ui: PromptUI,
    private readonly userIsTyping: () => boolean
  ) {}

  start(): void {
    if (this.timer) return;
    this.step = 0;
    this.timer = setInterval(() => {
      if (this.userIsTyping()) return;
      this.step = (this.step % 4) + 1;
      this.ui.status(chalk.gray("*".repeat(this.step)));
    }, 300);
    this.timer.unref(); // never the reason the process stays alive
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.ui.clearStatus();
  }
}

function stopResultText(result: { cancelledTurns: number; cancelledSubSessions: number }): string {
  const total = result.cancelledTurns + result.cancelledSubSessions;
  return total > 0
    ? chalk.gray(
        `(stopping everything: ${result.cancelledTurns} turn(s), ${result.cancelledSubSessions} sub-session(s))\n`
      )
    : chalk.gray("(nothing is running)\n");
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
