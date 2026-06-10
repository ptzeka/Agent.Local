import readline from "node:readline";
import process from "node:process";
import chalk from "chalk";

import type { SessionSummary } from "../agent/session/session-store.js";

/**
 * Startup session picker (UI layer).
 *
 * A hand-rolled arrow-key selector so resuming a session needs no prompt
 * library — the store already commits to a zero-dependency ethos and this
 * keeps the CLI in step. It drives raw-mode keypress events directly and,
 * crucially, fully restores the terminal before returning so the REPL's own
 * readline interface (created afterward) starts from a clean slate.
 */

export type PickResult =
  | { kind: "new" }
  | { kind: "resume"; sessionId: string };

/** Sentinel index for the always-present "create new session" row. */
const CREATE_NEW = 0;

/**
 * Present the saved sessions and let the user choose one to resume or start a
 * new one. ↑/↓ (or k/j) move, Enter selects, Esc/Ctrl+C aborts to a new
 * session. Falls back to "new" without prompting when stdin is not a TTY
 * (piped input, CI), where an interactive menu can't work.
 */
export async function pickSession(summaries: SessionSummary[]): Promise<PickResult> {
  if (!process.stdin.isTTY) return { kind: "new" };

  // Row 0 is "create new"; the rest map 1:1 onto summaries.
  const rowCount = summaries.length + 1;
  let selected = CREATE_NEW;
  let rendered = 0; // lines emitted last paint, so we can rewind and redraw.

  const paint = (): void => {
    if (rendered > 0) {
      // Rewind to the top of the previous block and clear downward.
      process.stdout.write(`\x1b[${rendered}A\x1b[0J`);
    }

    const lines: string[] = [];
    lines.push(chalk.bold("Select a session  ") + chalk.gray("(↑/↓ to move, Enter to choose, Esc for new)"));

    lines.push(rowFor(selected === CREATE_NEW, chalk.green("＋ Create new session"), ""));
    summaries.forEach((summary, index) => {
      const isSelected = selected === index + 1;
      lines.push(rowFor(isSelected, chalk.cyan(shortId(summary.sessionId)), describe(summary)));
    });

    process.stdout.write(lines.join("\n") + "\n");
    rendered = lines.length;
  };

  paint();

  const wasRaw = process.stdin.isRaw ?? false;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  try {
    const choice = await new Promise<PickResult>((resolve) => {
      const onKeypress = (
        _str: string | undefined,
        key: { name?: string; ctrl?: boolean } | undefined
      ): void => {
        if (!key) return;

        // Abort paths resolve to a brand-new session.
        if (key.name === "escape" || (key.ctrl && key.name === "c")) {
          cleanup();
          resolve({ kind: "new" });
          return;
        }

        if (key.name === "up" || key.name === "k") {
          selected = (selected - 1 + rowCount) % rowCount;
          paint();
          return;
        }
        if (key.name === "down" || key.name === "j") {
          selected = (selected + 1) % rowCount;
          paint();
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          cleanup();
          resolve(
            selected === CREATE_NEW
              ? { kind: "new" }
              : { kind: "resume", sessionId: summaries[selected - 1].sessionId }
          );
        }
      };

      const cleanup = (): void => {
        process.stdin.off("keypress", onKeypress);
      };

      process.stdin.on("keypress", onKeypress);
    });

    return choice;
  } finally {
    // Restore the terminal so the REPL's readline starts clean. Leave stdin
    // resumed — readline takes it over next.
    process.stdin.setRawMode(wasRaw);
  }
}

/** A menu row: highlighted (inverse) when selected, indented otherwise. */
function rowFor(selected: boolean, label: string, detail: string): string {
  const body = detail ? `${label}  ${chalk.gray(detail)}` : label;
  return selected ? chalk.inverse(`▶ ${body} `) : `  ${body}`;
}

/** First segment of a UUID — enough to recognise a session at a glance. */
function shortId(sessionId: string): string {
  return sessionId.split("-")[0] ?? sessionId.slice(0, 8);
}

/** "3 turns · 5m ago · <preview>" style detail for a saved session. */
function describe(summary: SessionSummary): string {
  const turns = `${summary.turns} turn${summary.turns === 1 ? "" : "s"}`;
  const when = relativeTime(summary.updatedAt);
  const preview = summary.preview ?? chalk.italic("(no messages yet)");
  return `${turns} · ${when} · ${preview}`;
}

/** Coarse "Nx ago" relative time; precise enough for an at-a-glance list. */
function relativeTime(epochMillis: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - epochMillis) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
