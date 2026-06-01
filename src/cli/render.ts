import chalk from "chalk";

import type { OrchestratorEvent } from "../agent/orchestrator.js";

/**
 * REPL renderer.
 *
 * The CLI layer keeps all colour/formatting decisions here so the orchestrator
 * stays UI-agnostic. The orchestrator emits structured events; this module
 * turns them into human-readable lines.
 */

export function renderEvent(event: OrchestratorEvent): void {
  switch (event.type) {
    case "planner-start": {
      const model = String(event.data.model ?? "");
      process.stdout.write(chalk.cyanBright(`\n[planner] thinking with ${model}…\n`));
      break;
    }

    case "planner-message": {
      const plan = String(event.data.content ?? "");
      process.stdout.write(chalk.cyan("[planner] plan:\n"));
      process.stdout.write(indent(plan, "  ") + "\n");
      break;
    }

    case "executor-start": {
      const model = String(event.data.model ?? "");
      const toolCount = Number(event.data.toolCount ?? 0);
      const native = event.data.supportsNativeTools ? "native tools" : "prompted-JSON tools";
      process.stdout.write(
        chalk.magentaBright(`\n[executor] ${model} (${native}, ${toolCount} tools available)\n`)
      );
      break;
    }

    case "executor-iteration": {
      const iteration = Number(event.data.iteration ?? 0);
      const max = Number(event.data.max ?? 0);
      process.stdout.write(chalk.gray(`  ── turn ${iteration}/${max}\n`));
      break;
    }

    case "executor-message": {
      const content = String(event.data.content ?? "").trim();
      if (content.length > 0) {
        process.stdout.write(chalk.magenta("[executor] ") + content + "\n");
      }
      break;
    }

    case "tool-call": {
      const name = String(event.data.name ?? "");
      const args = JSON.stringify(event.data.arguments ?? {}, null, 0);
      process.stdout.write(chalk.yellow(`  → tool: ${name} ${chalk.gray(args)}\n`));
      break;
    }

    case "tool-result": {
      const name = String(event.data.name ?? "");
      const isError = Boolean(event.data.isError);
      const preview = String(event.data.contentPreview ?? "");
      const colour = isError ? chalk.red : chalk.green;
      const label = isError ? "tool-error" : "tool-ok";
      process.stdout.write(colour(`  ← ${label}: ${name}\n`));
      if (preview.length > 0) {
        process.stdout.write(indent(preview, "    " + chalk.gray("│ ")) + "\n");
      }
      break;
    }

    case "final-message": {
      const content = String(event.data.content ?? "").trim();
      const iterations = Number(event.data.iterations ?? 0);
      process.stdout.write(chalk.greenBright(`\n[answer] (after ${iterations} turn(s))\n`));
      process.stdout.write(content + "\n");
      break;
    }

    case "warning": {
      const message = String(event.data.message ?? "");
      process.stdout.write(chalk.yellowBright(`[warning] ${message}\n`));
      break;
    }
  }
}

export function renderBanner(
  workspaceRoot: string,
  planFirst: boolean,
  contextPath?: string | null
): void {
  const lines = [
    "",
    chalk.bold("Agent.Local") + chalk.gray(" — local coding agent (Ollama + MCP)"),
    chalk.gray(`workspace: ${workspaceRoot}`),
    chalk.gray(`planner phase: ${planFirst ? "on" : "off"} (toggle with /think)`),
  ];
  if (contextPath) {
    lines.push(chalk.gray(`project context: ${contextPath}`));
  }
  lines.push(chalk.gray("type /help for commands, /exit to quit"), "");
  process.stdout.write(lines.join("\n"));
}

export function renderHelp(): void {
  const lines = [
    "",
    chalk.bold("Commands:"),
    "  /help                       show this help",
    "  /exit                       quit the REPL",
    "  /reset                      clear conversation history",
    "  /think on|off               toggle the planner phase for the next turn",
    "  /models                     list configured models and current role assignments",
    "  /model <role>=<model-id>    reassign a role to a different model id",
    "  /tools                      list every tool exposed by connected MCP servers",
    "  /history                    print the current conversation transcript",
    "",
  ];
  process.stdout.write(lines.join("\n"));
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
