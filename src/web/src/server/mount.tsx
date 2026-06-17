import path from "path";
import { fileURLToPath } from "url";
import type { Express } from "express";
import type { Eventing } from "@agent-local/common/eventing";
import { configContextMiddleware, defaultServerConfig } from "./middleware/config_context";
import { loggerContextMiddleware, type IServerLogger } from "./middleware/logger_context";
import { userContextMiddleware } from "./middleware/user_context";
import { staticAssetsMiddleware } from "./middleware/static_assets";
import { eventsSseMiddleware } from "./middleware/events_sse";
import { ssrRenderMiddleware } from "./middleware/ssr_render";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface MountContext {
  bus: Eventing;
  logger: IServerLogger;
  signal: AbortSignal;
}

// host seam: registers the console's middleware stack onto an externally owned express app; never
// creates its own Eventing bus — events flow through ctx.bus. The order mirrors the sandbox server:
// context middleware first (config -> logger -> user), then static + the live event bridge, then the
// catch-all SSR last so it can read the resolved request context and never shadows real routes.
export const mount = (app: Express, ctx: MountContext): void => {
  // client bundles sit next to this server bundle at static/ — webpack copies them in
  const staticDir = path.join(__dirname, "static");

  app.use(configContextMiddleware(defaultServerConfig()));
  app.use(loggerContextMiddleware(ctx.logger));
  app.use(userContextMiddleware());

  app.use("/static", staticAssetsMiddleware(staticDir));
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/events", eventsSseMiddleware(ctx.bus, ctx.signal));

  app.get(/.*/, ssrRenderMiddleware());

  ctx.logger.debug?.("@agent-local/web mounted (config/logger/user + static + SSE /events + SSR)");
  ctx.signal.addEventListener("abort", () => ctx.logger.debug?.("@agent-local/web mount aborted"));
};
