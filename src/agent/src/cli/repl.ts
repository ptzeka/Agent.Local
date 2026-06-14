import readline from "node:readline/promises";
import chalk from "chalk";

import type { McpClientRegistry } from "../agent/registries/mcp-registry.js";
import type { ModelRegistry } from "../agent/registries/model-registry.js";
import type { RunnerEvent } from "../agent/runners/runner-events.js";
import type { TurnRunner } from "../agent/runners/turn-runner.js";
import type { AgentRuntime } from "../agent/runtime/agent-runtime.js";
import { formatEvent, formatSubSessionNotification, formatTurnEvent, renderBanner, renderHelp, renderSession, type BannerSession } from "./render.js";

// wraps one session's runtime with a readline prompt and slash commands; all logic lives in the runtime,
// so the REPL only routes input in and events out
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

  // horizontal-only repaint (\r + clear-line + readline refresh) so output prints above a pinned prompt
  // without scroll-region support and never smears live typing
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT,
    terminal: true,
  });
  const ui = new ScreenLayout(rl);

  // first thing into the region, so it sits just above the pinned prompt at startup
  renderBanner(workspaceRoot, sandboxRoot, bannerSessionOf(runtime, resumed), null, (text) => ui.write(text));

  // surface out-of-band sub-session completions as they arrive, above the prompt
  const unsubscribe = runtime.onSubSessionEvent((notification) => {
    ui.write(formatSubSessionNotification(notification));
  });

  // map the bus shape {type,payload} to the renderer's {type,data} at this single boundary
  const unsubEvents = runtime.getEvents().subscribe((event) =>
    ui.write(formatEvent({ type: event.type, data: event.payload } as RunnerEvent))
  );

  // every turn flows through the runner's single pump, so no producer ever races the dispatchAsync guard
  const turnRunner = runtime.startTurnLoop({
    onTurnEvent: (event) => {
      // gate on isBusy because a turn can settle into another via auto-wake
      if (event.type === "turn-start") ui.startSpinner();
      if (event.type === "turn-done" && !turnRunner.isBusy) ui.stopSpinner();
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

  // line event + prompt(true), not rl.question(), because a question prompt can't be repainted mid-flight and scrolls away
  await new Promise<void>((resolve) => {
    const finish = () => {
      rl.off("line", onLine);
      resolve();
    };
    
    const onLine = (raw: string) => {
      const input = raw.trim();
      // lay the next prompt before any output/spinner repaints below the just-committed line
      ui.commit();
      if (input === "") return;

      // "stop" is an interrupt, not a prompt: queuing it would let the LLM interpret it after the work it meant to halt
      if (input.toLowerCase() === "stop") {
        ui.stopSpinner();
        ui.write(stopResultText(runtime.stopAllWork()));
        return;
      }

      if (input.startsWith("/")) {
        void handleSlashCommand(input.slice(1).trim(), ctx).then((exitRequested) => {
          if (exitRequested) finish();
        });
        return;
      }

      // push to the single inbox and let the pump wake; a turn in flight folds this in at its next iteration
      const wasBusy = turnRunner.isBusy;
      runtime.injectInput(input, "user");
      // immediate feedback; turn-start would also trigger it
      ui.startSpinner();
      if (wasBusy) {
        ui.write(chalk.gray("(queued — runs at the next step)\n"));
      }
    };

    rl.on("line", onLine);
    rl.once("close", finish);
    rl.prompt();
  });

  await runtime.stopTurnLoop();
  unsubEvents();
  unsubscribe();
  ui.close();
  rl.close();

  renderSession(bannerSessionOf(runtime, resumed));
}

// shared by the REPL and the headless exit summary so every mode reports the session the same way
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
  // routes through the pinned-prompt writer so command output never collides with the live bottom bar
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
      // the runtime stops and drains itself; this pre-pass only tells the user WHAT got cancelled
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

const SPINNER_FRAMES = ["*  ", "** ", "***", " **", "  *", "   "];
const SPINNER_INTERVAL_MS = 150;

// driven entirely through readline's own refresh (setPrompt + prompt(true)), avoiding scroll regions and
// absolute positioning that ConPTY ignores; the one manual cursor move is clearing the prompt block on output
class ScreenLayout {
  private readonly out: NodeJS.WriteStream = process.stdout;
  private readonly tty: boolean = Boolean(process.stdout.isTTY);
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;

  constructor(private readonly rl: readline.Interface) {
    this.rl.prompt();
  }

  // no-op on whitespace-only writes so the many "renders nothing" event cases don't churn the prompt
  write(text: string): void {
    const body = squeezeBlankLines(text);
    if (body.length === 0) return;
    if (this.tty) {
      // clear the whole prompt block (spinner row + wrapped input), whose height readline tracks as prevRows
      const up = this.promptRows();
      if (up > 0) this.out.write(`\x1b[${up}A`);
      this.out.write("\r\x1b[0J");
    }
    this.out.write(body + "\n");
    // tell readline the block restarts here (prevRows=0) so prompt(true) draws it under the output, not back up into it
    this.setPromptRows(0);
    this.rl.prompt(true);
  }

  // idempotent; no-op on a non-TTY
  startSpinner(): void {
    if (this.spinnerTimer || !this.tty) return;
    this.repaintSpinner();
    this.spinnerTimer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.repaintSpinner();
    }, SPINNER_INTERVAL_MS);
  }

  // collapses back to the single-line `you>` prompt
  stopSpinner(): void {
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
    this.rl.setPrompt(PROMPT);
    this.rl.prompt(true);
  }

  private repaintSpinner(): void {
    this.rl.setPrompt(chalk.yellow(SPINNER_FRAMES[this.frame]) + "\n" + PROMPT);
    this.rl.prompt(true);
  }

  // readline already froze the typed line into scrollback on Enter; this just draws the next prompt
  commit(): void {
    this.rl.prompt();
  }

  close(): void {
    this.stopSpinner();
  }

  // reaches into readline's private prevRows deliberately: it's the exact value readline uses to repaint the block
  private promptRows(): number {
    return Number((this.rl as unknown as { prevRows?: number }).prevRows ?? 0);
  }
  private setPromptRows(rows: number): void {
    (this.rl as unknown as { prevRows?: number }).prevRows = rows;
  }
}

// drops lines with no VISIBLE content (ANSI-only counts as blank) so output sits flush above the prompt;
// color codes from dropped rows carry onto the next kept line so coloring survives the squeeze
function squeezeBlankLines(text: string): string {
  const ansi = /\x1b\[[0-9;]*m/g;
  const codesOf = (line: string): string => (line.match(ansi) ?? []).join("");
  const kept: string[] = [];
  let carriedCodes = "";
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.replace(ansi, "").trim().length === 0) {
      carriedCodes += codesOf(line);
      continue;
    }
    kept.push(carriedCodes + line);
    carriedCodes = "";
  }
  if (carriedCodes.length > 0 && kept.length > 0) {
    kept[kept.length - 1] += carriedCodes;
  }
  return kept.join("\n");
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
