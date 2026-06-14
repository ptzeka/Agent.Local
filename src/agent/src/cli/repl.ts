import readline from "node:readline/promises";
import chalk from "chalk";

import type { McpClientRegistry } from "../agent/registries/mcp-registry.js";
import type { ModelRegistry } from "../agent/registries/model-registry.js";
import type { RunnerEvent } from "../agent/runners/runner-events.js";
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

  // Single owner of terminal layout. Output prints ABOVE a prompt that readline
  // keeps pinned at the bottom: each line clears the prompt row, writes itself,
  // then readline repaints prompt + in-progress input beneath it. Horizontal-only
  // (\r + clear-line + readline refresh), so it works on terminals without
  // scroll-region support and never smears live typing.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT,
    terminal: true,
  });
  const ui = new ScreenLayout(rl);

  // The banner is the first thing scrolled into the region, so it sits just
  // above the pinned prompt at startup.
  renderBanner(workspaceRoot, sandboxRoot, bannerSessionOf(runtime, resumed), null, (text) => ui.write(text));

  // Sub-session completions fire out-of-band (after the parent turn that
  // spawned them has ended). Surface them as they arrive, above the prompt.
  const unsubscribe = runtime.onSubSessionEvent((notification) => {
    ui.write(formatSubSessionNotification(notification));
  });

  // Turn events arrive on the runtime's bus (the turn publishes; we subscribe),
  // not through a callback. Map the bus shape {type,payload} to the renderer's
  // {type,data} at this single boundary.
  const unsubEvents = runtime.getEvents().subscribe((event) =>
    ui.write(formatEvent({ type: event.type, data: event.payload } as RunnerEvent))
  );

  // All turns flow through the runner's single pump: the REPL SUBMITS user
  // input fire-and-forget (the prompt never blocks), and settling sub-sessions
  // auto-wake the session through the same queue — no producer ever races the
  // dispatchAsync running-guard.
  const turnRunner = runtime.startTurnLoop({
    onTurnEvent: (event) => ui.write(formatTurnEvent(event)),
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
      // Enter froze the typed line into scrollback; lay the next prompt under it
      // before any output or spinner repaints below.
      ui.commit();
      if (input === "") return;

      // "stop" is an interrupt, not a prompt: with the input line always live,
      // it must never enter the queue (where it would be LLM-interpreted after
      // the very work it was meant to halt).
      if (input.toLowerCase() === "stop") {
        ui.write(stopResultText(runtime.stopAllWork()));
        return;
      }

      if (input.startsWith("/")) {
        void handleSlashCommand(input.slice(1).trim(), ctx).then((exitRequested) => {
          if (exitRequested) finish();
        });
        return;
      }

      // The inbox is the single injection interface: push the line and let the
      // pump wake. Typing while a turn runs folds the input into that turn at its
      // next iteration; typing while idle starts a fresh turn. Completion and
      // failures surface through the turn-event renderer, so nothing blocks here.
      const wasBusy = turnRunner.isBusy;
      runtime.injectInput(input, "user");
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
 * Owns the bottom prompt. Every line of output is printed ABOVE a `you>` prompt
 * that readline keeps pinned at the bottom: clear the prompt row, write the
 * line, then let readline repaint the prompt + any in-progress input beneath it.
 *
 * Deliberately horizontal-only — `\r` + clear-line + readline's own refresh,
 * never absolute cursor positioning or a scroll region — so it behaves
 * identically on terminals (ConPTY, basic TTYs) that don't honour DECSTBM. There
 * is exactly ONE repaint per real output line; nothing else (no spinner) touches
 * the prompt, because every extra repaint desyncs readline's hidden row state and
 * leaks blank lines.
 */
class ScreenLayout {
  private readonly out: NodeJS.WriteStream = process.stdout;
  private readonly tty: boolean = Boolean(process.stdout.isTTY);

  constructor(private readonly rl: readline.Interface) {
    this.rl.prompt();
  }

  /** Print finished output above the prompt. No-op on whitespace-only writes so
   *  the many "renders nothing" event cases don't churn the prompt. */
  write(text: string): void {
    const body = squeezeBlankLines(text);
    if (body.length === 0) return;
    if (this.tty) this.out.write("\r\x1b[2K"); // wipe the prompt row before output lands
    this.out.write(body + "\n");
    this.rl.prompt(true); // repaint prompt + in-progress input beneath the output
  }

  /** Lay a fresh prompt after the user commits a line (readline froze the typed
   *  line into scrollback on Enter; we just draw the next prompt). */
  commit(): void {
    this.rl.prompt();
  }

  close(): void {
    /* nothing to tear down: no scroll region or pinned rows were claimed */
  }
}

// Drop every blank line so output sits flush above the prompt. A line counts as
// blank when it has no VISIBLE content — even if it carries ANSI color codes.
// chalk wraps whole strings, so a decorative `\n…\n` becomes `ESC[..m\n…\nESC[..m`:
// the newlines move INSIDE the codes and an anchored `^\n+`/`\n+$` strip misses
// them. Color codes from dropped blank rows are carried onto the next kept line
// so coloring survives the squeeze; a trailing reset rides the last line's tail.
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
