import { FileLogger, resolveLogLevel, type LogLevel } from "../../../common/logger.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface LoggerMiddlewareParams {
  prefix?: string;
  /** Override the env-resolved level; omitted, LOG_LEVEL/DEBUG decide. */
  level?: LogLevel;
}

export class LoggerMiddleware implements IMiddleware {
  constructor(private readonly params?: LoggerMiddlewareParams) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    const level = this.params?.level ?? resolveLogLevel();
    ctx.logger = new FileLogger(this.params?.prefix ?? "AgentRuntime", level);
    await next();
  }
}
