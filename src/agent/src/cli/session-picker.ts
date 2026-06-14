import readline from "node:readline";
import process from "node:process";
import chalk from "chalk";

import type { SessionSummary } from "../agent/session/session-store.js";

// hand-rolled arrow-key selector to keep the CLI's zero-dependency ethos; restores the terminal
// fully before returning so the REPL's readline (created afterward) starts from a clean slate
export type PickResult =
  | { kind: "new" }
  | { kind: "resume"; sessionId: string };

const CREATE_NEW = 0;

// falls back to "new" without prompting when stdin is not a TTY (piped input, CI), where a menu can't work
export async function pickSession(summaries: SessionSummary[]): Promise<PickResult> {
  if (!process.stdin.isTTY) return { kind: "new" };

  // row 0 is "create new"; the rest map 1:1 onto summaries
  const rowCount = summaries.length + 1;
  let selected = CREATE_NEW;
  // lines emitted last paint, so we can rewind and redraw
  let rendered = 0;

  const paint = (): void => {
    if (rendered > 0) {
      // rewind to the top of the previous block and clear downward
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

        // abort paths resolve to a brand-new session
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
    // restore the terminal so the REPL's readline starts clean; leave stdin resumed for it to take over
    process.stdin.setRawMode(wasRaw);
  }
}

function rowFor(selected: boolean, label: string, detail: string): string {
  const body = detail ? `${label}  ${chalk.gray(detail)}` : label;
  return selected ? chalk.inverse(`▶ ${body} `) : `  ${body}`;
}

// first UUID segment, enough to recognise a session at a glance
function shortId(sessionId: string): string {
  return sessionId.split("-")[0] ?? sessionId.slice(0, 8);
}

function describe(summary: SessionSummary): string {
  const turns = `${summary.turns} turn${summary.turns === 1 ? "" : "s"}`;
  const when = relativeTime(summary.updatedAt);
  const preview = summary.preview ?? chalk.italic("(no messages yet)");
  return `${turns} · ${when} · ${preview}`;
}

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
