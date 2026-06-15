import { ILogger } from "@agent-local/common/ilogger";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface LoggerMiddlewareParams {
  logger: ILogger;
}

export class LoggerMiddleware implements IMiddleware {
  constructor(private readonly params: LoggerMiddlewareParams) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    ctx.logger = this.params?.logger;
    await next();
  }
}
