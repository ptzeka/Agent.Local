import { ConsoleLogger } from "../../../common/logger.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

export interface LoggerMiddlewareParams {
  prefix?: string;
}

export class LoggerMiddleware implements IMiddleware {
  constructor(private readonly params?: LoggerMiddlewareParams) {}

  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    ctx.logger = new ConsoleLogger(this.params?.prefix ?? "AgentRuntime");
    await next();
  }
}
