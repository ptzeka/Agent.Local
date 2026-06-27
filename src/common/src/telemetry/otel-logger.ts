import { logs, SeverityNumber, type Logger as OtelApiLogger } from "@opentelemetry/api-logs";
import { FileLogger } from "../filelogger.js";
import type { ILogger } from "../ilogger.js";

// per-level OTel severity; mirrors ILogger's four levels onto the log-data model
const SEVERITY: Record<keyof ILogger, { number: SeverityNumber; text: string }> = {
  error: { number: SeverityNumber.ERROR, text: "ERROR" },
  warn: { number: SeverityNumber.WARN, text: "WARN" },
  info: { number: SeverityNumber.INFO, text: "INFO" },
  debug: { number: SeverityNumber.DEBUG, text: "DEBUG" },
};

// ILogger that emits an OTel log record AND writes through a fallback logger. The OTel
// LoggerProvider is a no-op until an SDK is registered, so today output comes solely from the
// fallback (FileLogger) — the emit is the seam that goes live once an exporter is wired, with no
// call-site change. Substitutable for FileLogger so existing ILogger consumers are untouched.
export class OtelLogger implements ILogger {
  private readonly otel: OtelApiLogger;

  // fallback defaults to FileLogger because logs are still file-only — there is no SQLite log sink
  constructor(
    private readonly fallback: ILogger = new FileLogger(),
    loggerName = "@agent-local/common",
  ) {
    this.otel = logs.getLogger(loggerName);
  }

  error(message: string, ...args: unknown[]): void {
    this.emit("error", message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.emit("warn", message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.emit("info", message, args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.emit("debug", message, args);
  }

  private emit(level: keyof ILogger, message: string, args: unknown[]): void {
    const severity = SEVERITY[level];
    this.otel.emit({ severityNumber: severity.number, severityText: severity.text, body: message });
    this.fallback[level](message, ...args);
  }
}
