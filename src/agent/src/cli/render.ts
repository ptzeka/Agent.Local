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

/**
 * Format a runner event into a display string (empty when the event renders
 * nothing). Returns rather than writes so the REPL can emit it through the
 * single "write above the pinned prompt" path — see writeAbovePrompt.
 */
export function formatEvent(event: RunnerEvent): string {
  switch (event.type) {
    case "orchestrator-start": {
      const orch = String(event.data.orchestratorModel ?? "");
      const reads = Number(event.data.readToolCount ?? 0);
      return chalk.cyanBright(`\n[ORCHESTRATOR] ${orch} — ${reads} tools\n`);
    }

    case "orchestrator-iteration": {
      const iteration = Number(event.data.iteration ?? 0);
      const max = Number(event.data.max ?? 0);
      return chalk.gray(`  ── orchestrator turn ${iteration}/${max}\n`);
    }

    case "orchestrator-message": {
      const content = String(event.data.content ?? "").trim();
      return content.length > 0 ? chalk.cyan("[ORCHESTRATOR] ") + content + "\n" : "";
    }

    case "tool-call": {
      const name = String(event.data.name ?? "");
      const args = JSON.stringify(event.data.arguments ?? {}, null, 0);
      return chalk.yellow(`  → tool: ${name} ${chalk.gray(args)}\n`);
    }

    case "tool-result": {
      const name = String(event.data.name ?? "");
      const isError = Boolean(event.data.isError);
      const preview = String(event.data.contentPreview ?? "");
      const colour = isError ? chalk.red : chalk.green;
      const label = isError ? "tool-error" : "tool-ok";
      let out = colour(`  ← ${label}: ${name}\n`);
      if (preview.length > 0) {
        out += indent(preview, "    " + chalk.gray("│ ")) + "\n";
      }
      return out;
    }

    case "dispatch-start": {
      const tool = String(event.data.tool ?? "");
      const intent = String(event.data.intent ?? "");
      return chalk.magentaBright(`\n[DISPATCH] → ${tool}\n`) + chalk.gray(`           intent: ${intent}\n`);
    }

    case "dispatch-feedback": {
      const ok = Boolean(event.data.ok);
      const ack = String(event.data.ack ?? "");
      const evidence = String(event.data.evidence ?? "");
      const det = String(event.data.deterministicVerdict ?? "");
      const iterations = Number(event.data.iterations ?? 0);
      const stamp = ok ? chalk.greenBright("OK") : chalk.redBright("FAIL");
      return (
        chalk.magentaBright(`[DISPATCH] ← ${stamp}`) +
        chalk.gray(` (ack=${ack}, deterministic=${det}, executor turns=${iterations})\n`) +
        chalk.gray(`           evidence: ${evidence}\n`)
      );
    }

    case "executor-event": {
      return formatExecutorEvent(event.data);
    }

    case "final-message": {
      const content = String(event.data.content ?? "").trim();
      const iterations = Number(event.data.iterations ?? 0);
      return chalk.greenBright(`\n[answer] (after ${iterations} orchestrator turn(s))\n`) + content + "\n";
    }

    case "summarization": {
      const summarized = Number(event.data.summarizedCount ?? 0);
      const kept = Number(event.data.keptCount ?? 0);
      const chars = Number(event.data.summaryChars ?? 0);
      return chalk.gray(
        `[summarizer] folded ${summarized} message(s) into ~${chars} chars; kept last ${kept}\n`
      );
    }

    case "evaluation-start": {
      return chalk.gray("  [EVALUATOR] checking whether the request is fulfilled…\n");
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
      return chalk.gray("  [EVALUATOR] ") + stamp + chalk.gray(` — ${reason}\n`);
    }

    case "warning": {
      const message = String(event.data.message ?? "");
      return chalk.yellowBright(`[warning] ${message}\n`);
    }

    default:
      return "";
  }
}

/**
 * Render turn-loop scheduling events. Deliberately quiet for plain user turns
 * (the prompt/await flow already narrates those); only out-of-band activity —
 * auto-wake turns from settling sub-sessions, queued/coalesced work — gets a
 * line, so the user can see WHY the agent started talking unprompted.
 */
export function formatTurnEvent(event: TurnRunnerEvent): string {
  switch (event.type) {
    case "turn-start":
      // A turn the user did not type (a settling sub-session woke the session)
      // is the only one worth announcing — own input already shows the spinner.
      return event.source !== "user"
        ? chalk.gray(`\n(auto-wake: processing ${event.source} report)\n`)
        : "";
    case "turn-done":
      // The REPL never awaits a turn's settle (the prompt stays live for
      // mid-turn injection), so a failure must surface here or nowhere.
      if (event.status === "error") {
        return chalk.red(`\n[error] turn failed\n`);
      }
      return event.status === "cancelled" ? chalk.yellowBright("\n(turn cancelled)\n") : "";
    default:
      return "";
  }
}

/**
 * Render a sub-session completion that arrived out-of-band (the child settled
 * after the parent's turn ended). Prefixed with a newline so it doesn't smear
 * the live `you>` prompt, and tagged so it's clearly an async report rather
 * than part of the current turn's output.
 */
export function formatSubSessionNotification(notification: SubSessionNotification): string {
  const shortId = notification.subSessionId.split("-")[0] ?? notification.subSessionId.slice(0, 8);
  const intent = notification.intent.replace(/\s+/g, " ").trim();

  if (notification.status === "done") {
    const result = (notification.result ?? "").replace(/\s+/g, " ").trim();
    const preview = result.length > 200 ? `${result.slice(0, 199)}…` : result;
    return (
      "\n" +
      chalk.greenBright(`✓ [sub-session ${shortId} done] `) +
      chalk.gray(intent) +
      (preview.length > 0 ? `\n  ${preview}` : "") +
      "\n"
    );
  }

  const reason = (notification.error ?? "unknown error").replace(/\s+/g, " ").trim();
  return (
    "\n" + chalk.redBright(`✗ [sub-session ${shortId} error] `) + chalk.gray(intent) + `\n  ${reason}\n`
  );
}

// Executor sub-run lines render gray: they persist in the CHILD session's
// transcript, not this conversation, so by the saved-keeps-color convention
// they are transient here. Errors stay red — failure must remain visible.
function formatExecutorEvent(data: Record<string, unknown>): string {
  const kind = String(data.kind ?? "");
  switch (kind) {
    // Orchestrator-style events forwarded from the executor sub-run.
    case "orchestrator-start": {
      const model = String(data.orchestratorModel ?? "");
      return chalk.gray(`  [EXECUTOR] running (${model})\n`);
    }
    case "orchestrator-message": {
      const content = String(data.content ?? "").trim();
      return content.length > 0 ? chalk.gray(`  [EXECUTOR] ${content}\n`) : "";
    }
    case "tool-call": {
      const name = String(data.name ?? "");
      const args = JSON.stringify(data.arguments ?? {}, null, 0);
      return chalk.gray(`  [EXECUTOR] → tool: ${name} ${args}\n`);
    }
    case "tool-result": {
      const name = String(data.name ?? "");
      const isError = Boolean(data.isError);
      const colour = isError ? chalk.red : chalk.gray;
      return colour(`  [EXECUTOR] ← ${isError ? "tool-error" : "tool-ok"}: ${name}\n`);
    }
    case "warning": {
      const message = String(data.message ?? "");
      // Executor warnings aren't persisted to this conversation: gray the line
      // per the saved-keeps-color convention, but the "warning" word stays
      // colored — it's the signal being scanned for.
      return chalk.gray("  [EXECUTOR] ") + chalk.yellowBright("warning") + chalk.gray(`: ${message}\n`);
    }
    default:
      return "";
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
  // summary to stderr; the REPL routes through its pinned-prompt writer.
  write: (text: string) => void = (text) => void process.stdout.write(text)
): void {
  write(chalk.gray(`session:   ${sessionLine(session)}\n`));
}

export function renderHelp(write: (text: string) => void = (text) => void process.stdout.write(text)): void {
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
  write(lines.join("\n"));
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
