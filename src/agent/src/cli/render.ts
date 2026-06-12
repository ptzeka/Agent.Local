import chalk from "chalk";

import type { RunnerEvent } from "../agent/runners/runner-events.js";
import type { SubSessionNotification } from "../agent/runners/subsession.js";
import type { TurnRunnerEvent } from "../agent/runners/turn-runner.js";

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

export function renderEvent(event: RunnerEvent): void {
  switch (event.type) {
    case "orchestrator-start": {
      const orch = String(event.data.orchestratorModel ?? "");
      const reads = Number(event.data.readToolCount ?? 0);
      process.stdout.write(
        chalk.cyanBright(`\n[ORCHESTRATOR] ${orch} — ${reads} tools\n`)
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
            : state === "awaiting-input"
              ? chalk.blueBright("AWAITING-INPUT")
              : chalk.yellowBright(state.toUpperCase() || "UNSATISFIED");
      // Verdicts are turn-transient (events only, never persisted to the
      // conversation): gray label per the saved-keeps-color convention, but
      // the verdict word stays colored — it's the line being scanned for.
      process.stdout.write(chalk.gray("  [EVALUATOR] ") + stamp + chalk.gray(` — ${reason}\n`));
      break;
    }

    case "warning": {
      const message = String(event.data.message ?? "");
      process.stdout.write(chalk.yellowBright(`[warning] ${message}\n`));
      break;
    }
  }
}

/**
 * Render turn-loop scheduling events. Deliberately quiet for plain user turns
 * (the prompt/await flow already narrates those); only out-of-band activity —
 * auto-wake turns from settling sub-sessions, queued/coalesced work — gets a
 * line, so the user can see WHY the agent started talking unprompted.
 */
export function renderTurnEvent(event: TurnRunnerEvent): void {
  switch (event.type) {
    case "turn-queued":
      if (event.source !== "user") {
        process.stdout.write(
          chalk.gray(`\n(queued ${event.source} turn — ${event.queueDepth} waiting)\n`)
        );
      }
      break;
    case "turn-start":
      if (event.source !== "user") {
        process.stdout.write(chalk.gray(`\n(auto-wake: processing ${event.source} report)\n`));
      }
      break;
    case "round-start":
      // Rounds beyond the first mean mid-turn feedback was folded in.
      if (event.round > 1) {
        process.stdout.write(chalk.gray(`\n(round ${event.round}: ${event.source} feedback folded into this turn)\n`));
      }
      break;
    case "round-done":
      // The REPL no longer awaits a turn's settle (the prompt stays live for
      // mid-turn injection), so failures must surface here or nowhere.
      if (event.status === "error") {
        const errorDetail = event.error ?? "unknown error";
        process.stdout.write(chalk.red(`\n[error] turn round failed:\n${errorDetail}\n`));
      }
      break;
    case "turn-done":
      if (event.status === "cancelled") {
        process.stdout.write(chalk.yellowBright("\n(turn cancelled)\n"));
      }
      break;
  }
}

/**
 * Render a sub-session completion that arrived out-of-band (the child settled
 * after the parent's turn ended). Prefixed with a newline so it doesn't smear
 * the live `you>` prompt, and tagged so it's clearly an async report rather
 * than part of the current turn's output.
 */
export function renderSubSessionNotification(notification: SubSessionNotification): void {
  const shortId = notification.subSessionId.split("-")[0] ?? notification.subSessionId.slice(0, 8);
  const intent = notification.intent.replace(/\s+/g, " ").trim();

  if (notification.status === "done") {
    const result = (notification.result ?? "").replace(/\s+/g, " ").trim();
    const preview = result.length > 200 ? `${result.slice(0, 199)}…` : result;
    process.stdout.write(
      "\n" +
        chalk.greenBright(`✓ [sub-session ${shortId} done] `) +
        chalk.gray(intent) +
        (preview.length > 0 ? `\n  ${preview}` : "") +
        "\n"
    );
    return;
  }

  const reason = (notification.error ?? "unknown error").replace(/\s+/g, " ").trim();
  process.stdout.write(
    "\n" +
      chalk.redBright(`✗ [sub-session ${shortId} error] `) +
      chalk.gray(intent) +
      `\n  ${reason}\n`
  );
}

// Executor sub-run lines render gray: they persist in the CHILD session's
// transcript, not this conversation, so by the saved-keeps-color convention
// they are transient here. Errors stay red — failure must remain visible.
function renderExecutorEvent(data: Record<string, unknown>): void {
  const kind = String(data.kind ?? "");
  switch (kind) {
    // Orchestrator-style events forwarded from the executor sub-run.
    case "orchestrator-start": {
      const model = String(data.orchestratorModel ?? "");
      process.stdout.write(chalk.gray(`  [EXECUTOR] running (${model})\n`));
      return;
    }
    case "orchestrator-message": {
      const content = String(data.content ?? "").trim();
      if (content.length > 0) {
        process.stdout.write(chalk.gray(`  [EXECUTOR] ${content}\n`));
      }
      return;
    }
    case "tool-call": {
      const name = String(data.name ?? "");
      const args = JSON.stringify(data.arguments ?? {}, null, 0);
      process.stdout.write(chalk.gray(`  [EXECUTOR] → tool: ${name} ${args}\n`));
      return;
    }
    case "tool-result": {
      const name = String(data.name ?? "");
      const isError = Boolean(data.isError);
      const colour = isError ? chalk.red : chalk.gray;
      process.stdout.write(colour(`  [EXECUTOR] ← ${isError ? "tool-error" : "tool-ok"}: ${name}\n`));
      return;
    }
    case "warning": {
      const message = String(data.message ?? "");
      process.stdout.write(chalk.yellowBright(`  [EXECUTOR] warning: ${message}\n`));
      return;
    }
  }
}

/** Identity of the session this REPL drives, shown in the startup banner. */
export interface BannerSession {
  sessionId: string;
  /** Transcript link — the session's rolling conversation file. */
  conversationId: string;
  /** Workspace the session is bound to. */
  workspaceId: string;
  /** Content-addressed pointer to the captured context, when one was stamped. */
  contextHashes: Record<string, string>;
  /** True when resumed from disk, false for a freshly bootstrapped session. */
  resumed: boolean;
  /** Completed user turns (0 for a new session). */
  turns: number;
  /** Short description — the first user message, or null when none yet. */
  preview: string | null;
}

export function renderBanner(
  workspaceRoot: string,
  sandboxRoot: string,
  session: BannerSession,
  contextPath?: string | null
): void {
  const lines = [
    "",
    chalk.bold("Agent.Local") + chalk.gray(" — local coding agent (Ollama + MCP)"),
    chalk.gray(`session:   ${sessionLine(session)}`),
    chalk.gray(`project:   ${workspaceRoot}`),
    chalk.gray(`fs sandbox: ${sandboxRoot} (all file I/O confined here)`),
    chalk.gray("architecture: orchestrator (read-only) → executor__dispatch → executor (mutations)"),
  ];
  if (contextPath) {
    lines.push(chalk.gray(`project context: ${contextPath}`));
  }
  lines.push(chalk.gray("type /help for commands, /exit to quit"), "");
  process.stdout.write(lines.join("\n"));
}

/**
 * "id=b1557363 · conv=9c2e11d4 · ctx=3f8a1c2b · ws=ad2f457f · new" identity
 * line. On a resumed session the origin is followed by the turn count and a
 * description of the opening message. ctx falls back to "none" when no
 * snapshot was stamped.
 */
function sessionLine(session: BannerSession): string {
  const id = `id=${short(session.sessionId)}`;
  const conv = `conv=${short(session.conversationId)}`;
  const ctx = `ctx=${session.contextHashes["orchestrator"] ? short(session.contextHashes["orchestrator"]) : "none"}`;
  const ws = `ws=${short(session.workspaceId)}`;

  let origin: string = session.resumed ? "resumed" : "new";
  if (session.resumed) {
    const turns = `${session.turns} turn${session.turns === 1 ? "" : "s"}`;
    const desc = session.preview ? ` · ${session.preview}` : "";
    origin += ` — ${turns}${desc}`;
  }

  return `${id} · ${conv} · ${ctx} · ${ws} · ${origin}`;
}

/** First 8 chars — enough to eyeball/grep an id without wrapping the banner. */
function short(value: string): string {
  return value.slice(0, 8);
}

export function renderSession(
  session: BannerSession,
  // Headless runs keep stdout reserved for the final answer, so they route the
  // summary to stderr; the REPL keeps the stdout default.
  out: NodeJS.WritableStream = process.stdout
): void {
  out.write(chalk.gray(`session:   ${sessionLine(session)}\n`));
}

export function renderHelp(): void {
  const lines = [
    "",
    chalk.bold("Commands:"),
    "  /help                       show this help",
    "  /exit                       quit the REPL",
    "  /stop                       stop everything: current turn, queued turns, sub-sessions (typing \"stop\" works too)",
    "  /reset                      stop everything, then clear conversation history",
    "  /compact                    stop everything, then fold the conversation into a summary checkpoint",
    "  /session                    print current session info (id, ctx hash, workspace, turns)",
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
