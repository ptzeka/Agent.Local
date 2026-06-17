import { type Express } from "express";
import { type MountContext } from "../mount.js";
import { mountFeature } from "./mount-feature.js";

// the agent worker — a bus-only feature (no HTTP routes). It mounts through the same seam as the HTTP
// features but ignores the express app: it couples to the system purely via ctx.bus (agent.job -> agent.result).
export async function wireAgentWorker(app: Express, ctx: MountContext): Promise<void> {
  await mountFeature("@agent-local/agent/mount", app, ctx, ctx.logger);
}
