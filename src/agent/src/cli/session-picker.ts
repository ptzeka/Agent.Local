import readline from "node:readline";
import process from "node:process";
import chalk from "chalk";

import type { SessionSummary } from "../agent/session/session-store.js";

// hand-rolled arrow-key selector to keep the CLI's zero-dependency ethos; restores the terminal
// fully before returning so the REPL's readline (created afterward) starts from a clean slate
export type PickResult =
  | { kind: "new" }
  | { kind: "resume"; sessionId: string }
  | { kind: "login" };

// null userName means logged out: the header stays generic and a "Log in" row is offered;
// a name means the caller resolved an identity, so the header welcomes it and the row disappears
export interface PickerIdentity {
  userName: string | null;
}

const CREATE_NEW = 0;

// falls back to "new" without prompting when stdin is not a TTY (piped input, CI), where a menu can't work
export async function pickSession(
  summaries: SessionSummary[],
  identity: PickerIdentity = { userName: null }
): Promise<PickResult> {
  if (!process.stdin.isTTY) return { kind: "new" };

  // row 0 is "create new"; when logged out row 1 offers login; the rest map 1:1 onto summaries
  const loginRow = identity.userName === null;
  const summaryOffset = loginRow ? 2 : 1;
  const rowCount = summaries.length + summaryOffset;
  let selected = CREATE_NEW;
  // lines emitted last paint, so we can rewind and redraw
  let rendered = 0;

  const paint = (): void => {
    if (rendered > 0) {
      // rewind to the top of the previous block and clear downward
      process.stdout.write(`\x1b[${rendered}A\x1b[0J`);
    }

    const lines: string[] = [];
    const title = identity.userName
      ? chalk.bold(`Welcome ${chalk.green(identity.userName)} — select a session  `)
      : chalk.bold("Select a session  ");
    lines.push(title + chalk.gray("(↑/↓ to move, Enter to choose, Esc for new)"));

    lines.push(rowFor(selected === CREATE_NEW, chalk.green("＋ Create new session"), ""));
    if (loginRow) {
      lines.push(rowFor(selected === 1, chalk.yellow("⚿ Log in"), "browser sign-in — skip to stay anonymous"));
    }
    summaries.forEach((summary, index) => {
      const isSelected = selected === index + summaryOffset;
      lines.push(rowFor(isSelected, chalk.cyan(shortId(summary.sessionId)), describe(summary)));
    });

    process.stdout.write(lines.join("\n") + "\n");
    // count terminal rows, not logical lines: a line longer than the window wraps onto extra rows,
    // and rewinding short of those leaves stale copies stacking above the menu
    rendered = lines.reduce((rows, line) => rows + terminalRows(line), 0);
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

        // clamp at the edges — no wrap-around, and no repaint when nothing moved
        if (key.name === "up" || key.name === "k") {
          if (selected > 0) {
            selected -= 1;
            paint();
          }
          return;
        }
        if (key.name === "down" || key.name === "j") {
          if (selected < rowCount - 1) {
            selected += 1;
            paint();
          }
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          cleanup();
          resolve(
            selected === CREATE_NEW
              ? { kind: "new" }
              : loginRow && selected === 1
                ? { kind: "login" }
                : { kind: "resume", sessionId: summaries[selected - summaryOffset].sessionId }
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

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function terminalRows(line: string): number {
  const width = process.stdout.columns || 80;
  const visible = line.replace(ANSI_PATTERN, "").length;
  return Math.max(1, Math.ceil(visible / width));
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
