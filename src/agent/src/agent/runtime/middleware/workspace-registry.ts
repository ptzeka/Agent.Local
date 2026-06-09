import { WorkspaceRegistry } from "../../workspace-registry.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

/**
 * WorkspaceRegistryMiddleware — creates the workspace → root/context map.
 *
 * SessionMiddleware registers and resolves the session's workspace against this
 * registry, so it must run earlier in the pipeline. Sets ctx.workspaces before
 * calling next().
 */
export class WorkspaceRegistryMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    ctx.workspaces = new WorkspaceRegistry();
    await next();
  }
}
