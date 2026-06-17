import { type Express } from "express";
import { type ILogger } from "@agent-local/common";
import { type Mount, type MountContext } from "../mount.js";

// integration seam: dynamically import a feature workspace and call its mount(app, ctx). A missing
// sibling must not stop the host, so absence is logged and skipped (standalone boot, parallel dev).
export async function mountFeature(
  spec: string,
  app: Express,
  ctx: MountContext,
  logger: ILogger,
): Promise<void> {
  try {
    const mod = (await import(spec)) as { mount?: Mount };
    if (typeof mod.mount !== "function") {
      logger.warn(`[host] ${spec} has no exported mount(); skipping`);
      return;
    }
    mod.mount(app, ctx);
    logger.info(`[host] mounted ${spec}`);
  } catch {
    // sibling not present in this build — expected during standalone boot and parallel development
    logger.info(`[host] ${spec} not available; skipping mount`);
  }
}
