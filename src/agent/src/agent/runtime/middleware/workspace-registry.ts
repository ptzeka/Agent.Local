import { WorkspaceRegistry } from "../../registries/workspace-registry.js";
import { WorkspacesToken } from "../tokens.js";
import type { IMiddleware, RuntimeContext } from "../types.js";

// creates the workspace → root/context map; must run before SessionMiddleware, which resolves against it
export class WorkspaceRegistryMiddleware implements IMiddleware {
  async initialize(ctx: RuntimeContext, next: () => Promise<void>): Promise<void> {
    ctx.registry.set(WorkspacesToken, new WorkspaceRegistry());
    await next();
  }
}
