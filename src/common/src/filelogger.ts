import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { type ILogger } from "./ilogger.js";
export type LogLevel = "error" | "warn" | "info" | "debug";

// Higher rank = more verbose; a message is written when its rank is <= the active level.
const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

// LOG_LEVEL wins, DEBUG is shorthand for debug, else info; read once so one env var sets every subsystem's verbosity
export function resolveLogLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw === "error" || raw === "warn" || raw === "info" || raw === "debug")
    return raw;
  return process.env.DEBUG ? "debug" : "info";
}

// MDYYYY so each day gets its own log file
function logDateStamp(now: Date): string {
  return `${now.getMonth() + 1}${now.getDate()}${now.getFullYear()}`;
}

// out-of-band sink to `tail -f` while the REPL owns the terminal
function resolveLogFile(): string {
  return process.env.AGENT_LOG_FILE
    ? path.resolve(process.env.AGENT_LOG_FILE)
    : path.resolve(process.cwd(), "logs", `agent-${logDateStamp(new Date())}.log`);
}

// records go out-of-band, never to stdout/stderr which the REPL prompt and headless answer own; swap for a DB writer later
// appends are synchronous: volume is low, order matters, and a sync write can't be lost to an unflushed buffer on exit
export class FileLogger implements ILogger {
  private readonly level: LogLevel;
  private readonly file: string;

  constructor(private readonly prefix?: string, level?: LogLevel, file?: string) {
    this.level = level ?? resolveLogLevel();
    this.file = file ?? resolveLogFile();
    // create the dir up front, else the append ENOENTs and the write's catch swallows it — no logs, no error
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
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
      // a logging failure must never break the thing being logged
    }
  }
}
