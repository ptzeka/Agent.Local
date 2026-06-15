import { Container } from "@agent-local/common/container";
import type { IMiddleware, RuntimeContext } from "../types.js";

// creates the per-runtime service container; must run FIRST so every later step has ctx.registry to set into
export class ContainerMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    ctx.registry = new Container();
    await next();
  }
}
