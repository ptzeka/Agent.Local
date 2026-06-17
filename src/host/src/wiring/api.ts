import express, { type Express } from "express";
import { type MountContext } from "../mount.js";
import { mountFeature } from "./mount-feature.js";

// HTTP feature workspaces — they contribute express routes/middleware to the host app
// (web: SSR + /events SSE; workflow: the camunda control surface)
const HTTP_FEATURES = ["@agent-local/web", "@agent-local/workflow"] as const;

// the host's own express surface plus the HTTP feature mounts: json body parsing, liveness, web & workflow
export async function wireApi(app: Express, ctx: MountContext): Promise<void> {
  app.use(express.json());
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  for (const name of HTTP_FEATURES) await mountFeature(name, app, ctx, ctx.logger);
}
