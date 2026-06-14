import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

// Higher rank = more verbose; a message is written when its rank is <= the active level.
const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * Resolve the active log level from the environment. `LOG_LEVEL` wins; `DEBUG`
 * is a shorthand for the debug level; otherwise default to info. Read once per
 * logger so a single env var controls every subsystem's verbosity.
 */
export function resolveLogLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw === "error" || raw === "warn" || raw === "info" || raw === "debug") return raw;
  return process.env.DEBUG ? "debug" : "info";
}

/** Where local logs land. `tail -f` this while the REPL owns the terminal. */
function resolveLogFile(): string {
  return process.env.AGENT_LOG_FILE
    ? path.resolve(process.env.AGENT_LOG_FILE)
    : path.resolve(process.cwd(), "agent.log");
}

/**
 * Local file sink standing in for the eventual persistence backend (DB). The
 * point of the `Logger` abstraction is that records go OUT-of-band — never to
 * stdout/stderr, which the REPL's pinned prompt and the headless answer own.
 * Swap this implementation for a DB writer later; call sites don't change.
 *
 * Appends are synchronous: log volume is low and order matters, and a sync
 * write can't be lost to an unflushed buffer on exit.
 */
export class FileLogger implements Logger {
  private readonly level: LogLevel;
  private readonly file: string;

  constructor(private readonly prefix?: string, level?: LogLevel, file?: string) {
    this.level = level ?? resolveLogLevel();
    this.file = file ?? resolveLogFile();
  }

  error(message: string, ...args: unknown[]): void {
    this.write("error", message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write("warn", message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write("info", message, args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.write("debug", message, args);
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    if (LEVEL_RANK[level] > LEVEL_RANK[this.level]) return;
    const head = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${this.prefix ? `[${this.prefix}] ` : ""}`;
    try {
      fs.appendFileSync(this.file, format(head + message, ...args) + "\n");
    } catch {
      // A logging failure must never break the thing being logged.
    }
  }
}
