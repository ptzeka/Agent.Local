import chalk from "chalk";

import type { OrchestratorEvent } from "../agent/orchestrator.js";

/**
 * REPL renderer.
 *
 * The CLI layer keeps all colour/formatting decisions here so the
 * orchestrator stays UI-agnostic. The orchestrator emits structured
 * events; this module turns them into human-readable lines.
 *
 * Two role labels are used consistently:
 *   ORCHESTRATOR — cyan, coordinator messages and read-only tool calls.
 *   EXECUTOR     — magenta, ack/execute/validate/report inside one dispatch.
 */

export function renderEvent(event: OrchestratorEvent): void {
  switch (event.type) {
    case "orchestrator-start": {
      const orch = String(event.data.orchestratorModel ?? "");
      const exec = String(event.data.executorModel ?? "");
      const reads = Number(event.data.readToolCount ?? 0);
      const execs = Number(event.data.executorToolCount ?? 0);
      process.stdout.write(
        chalk.cyanBright(
          `\n[ORCHESTRATOR] ${orch} — ${reads} read tools, dispatch_executor → ${exec} (${execs} tools)\n`
        )
      );
      break;
    }

    case "orchestrator-iteration": {
      const iteration = Number(event.data.iteration ?? 0);
      const max = Number(event.data.max ?? 0);
      process.stdout.write(chalk.gray(`  ── orchestrator turn ${iteration}/${max}\n`));
      break;
    }

    case "orchestrator-message": {
      const content = String(event.data.content ?? "").trim();
      if (content.length > 0) {
        process.stdout.write(chalk.cyan("[ORCHESTRATOR] ") + content + "\n");
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

    case "dispatch-start": {
      const tool = String(event.data.tool ?? "");
      const intent = String(event.data.intent ?? "");
      process.stdout.write(
        chalk.magentaBright(`\n[DISPATCH] → ${tool}\n`) + chalk.gray(`           intent: ${intent}\n`)
      );
      break;
    }

    case "dispatch-feedback": {
      const ok = Boolean(event.data.ok);
      const ack = String(event.data.ack ?? "");
      const evidence = String(event.data.evidence ?? "");
      const det = String(event.data.deterministicVerdict ?? "");
      const iterations = Number(event.data.iterations ?? 0);
      const stamp = ok ? chalk.greenBright("OK") : chalk.redBright("FAIL");
      process.stdout.write(
        chalk.magentaBright(`[DISPATCH] ← ${stamp}`) +
          chalk.gray(
            ` (ack=${ack}, deterministic=${det}, executor turns=${iterations})\n`
          ) +
          chalk.gray(`           evidence: ${evidence}\n`)
      );
      break;
    }

    case "executor-event": {
      renderExecutorEvent(event.data);
      break;
    }

    case "final-message": {
      const content = String(event.data.content ?? "").trim();
      const iterations = Number(event.data.iterations ?? 0);
      process.stdout.write(chalk.greenBright(`\n[answer] (after ${iterations} orchestrator turn(s))\n`));
      process.stdout.write(content + "\n");
      break;
    }

    case "summarization": {
      const summarized = Number(event.data.summarizedCount ?? 0);
      const kept = Number(event.data.keptCount ?? 0);
      const chars = Number(event.data.summaryChars ?? 0);
      process.stdout.write(
        chalk.gray(
          `[summarizer] folded ${summarized} message(s) into ~${chars} chars; kept last ${kept}\n`
        )
      );
      break;
    }

    case "evaluation-start": {
      process.stdout.write(chalk.gray("  [EVALUATOR] checking whether the request is fulfilled…\n"));
      break;
    }

    case "evaluation-verdict": {
      const state = String(event.data.state ?? "");
      const reason = String(event.data.reason ?? "");
      const stamp =
        state === "satisfied"
          ? chalk.greenBright("SATISFIED")
          : state === "continue"
            ? chalk.cyanBright("CONTINUE")
            : chalk.yellowBright("UNSATISFIED");
      process.stdout.write(chalk.magenta("  [EVALUATOR] ") + stamp + chalk.gray(` — ${reason}\n`));
      break;
    }

    case "warning": {
      const message = String(event.data.message ?? "");
      process.stdout.write(chalk.yellowBright(`[warning] ${message}\n`));
      break;
    }
  }
}

function renderExecutorEvent(data: Record<string, unknown>): void {
  const kind = String(data.kind ?? "");
  switch (kind) {
    case "executor-start": {
      const model = String(data.model ?? "");
      const tool = String(data.tool ?? "");
      process.stdout.write(chalk.magenta(`  [EXECUTOR] start (${model}) tool=${tool}\n`));
      return;
    }
    case "executor-ack": {
      const ack = String(data.ack ?? "");
      process.stdout.write(chalk.magenta(`  [EXECUTOR] ACK ${ack}\n`));
      return;
    }
    case "executor-tool-call": {
      const name = String(data.name ?? "");
      process.stdout.write(chalk.yellow(`  [EXECUTOR] → ${name}\n`));
      return;
    }
    case "executor-validate": {
      const name = String(data.name ?? "");
      process.stdout.write(chalk.cyan(`  [EXECUTOR] validate → ${name}\n`));
      return;
    }
    case "executor-tool-result": {
      const name = String(data.name ?? "");
      const isError = Boolean(data.isError);
      const colour = isError ? chalk.red : chalk.green;
      const label = isError ? "tool-error" : "tool-ok";
      process.stdout.write(colour(`  [EXECUTOR] ← ${label}: ${name}\n`));
      return;
    }
    case "executor-report": {
      const verdict = String(data.verdict ?? "");
      const message = String(data.message ?? "");
      const colour = verdict === "OK" ? chalk.greenBright : chalk.redBright;
      process.stdout.write(colour(`  [EXECUTOR] RESULT ${verdict} `) + chalk.gray(message) + "\n");
      return;
    }
    case "executor-deterministic-verdict": {
      const verdict = String(data.verdict ?? "");
      const evidence = String(data.evidence ?? "");
      process.stdout.write(chalk.gray(`  [EXECUTOR] deterministic=${verdict} — ${evidence}\n`));
      return;
    }
    case "executor-warning": {
      const reason = String(data.reason ?? "");
      process.stdout.write(chalk.yellowBright(`  [EXECUTOR] warning: ${reason}\n`));
      return;
    }
  }
}

export function renderBanner(
  workspaceRoot: string,
  sandboxRoot: string,
  contextPath?: string | null
): void {
  const lines = [
    "",
    chalk.bold("Agent.Local") + chalk.gray(" — local coding agent (Ollama + MCP)"),
    chalk.gray(`project:   ${workspaceRoot}`),
    chalk.gray(`fs sandbox: ${sandboxRoot} (all file I/O confined here)`),
    chalk.gray("architecture: orchestrator (read-only) → dispatch_executor → executor (mutations)"),
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
    "  /models                     list configured models and current role assignments",
    "  /model <role>=<model-id>    reassign a role (orchestrator, executor, …)",
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
