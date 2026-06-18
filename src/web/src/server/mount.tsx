import path from "path";
import { fileURLToPath } from "url";
import type { Express } from "express";
import type { Eventing } from "@agent-local/common/eventing";
import type { AppSettings } from "@agent-local/common";
import { configContextMiddleware, defaultServerConfig, serverConfigFromSettings } from "./middleware/config_context.js";
import { loggerContextMiddleware, type IServerLogger } from "./middleware/logger_context.js";
import { userContextMiddleware } from "./middleware/user_context.js";
import { staticAssetsMiddleware } from "./middleware/static_assets.js";
import { eventsSseMiddleware } from "./middleware/events_sse.js";
import { ssrRenderMiddleware } from "./middleware/ssr_render.js";

// __MODULE_URL__ is injected per bundle (DefinePlugin) so the runtime dir is correct in both CJS and ESM
declare const __MODULE_URL__: string;
const __dirname = path.dirname(fileURLToPath(__MODULE_URL__));

export interface MountContext {
  bus: Eventing;
  logger: IServerLogger;
  signal: AbortSignal;
  // the host passes the whole appsettings; the console reads only its `web` section
  settings?: AppSettings;
}

// host seam: registers the console's middleware stack onto an externally owned express app; never
// creates its own Eventing bus — events flow through ctx.bus. The order mirrors the sandbox server:
// context middleware first (config -> logger -> user), then static + the live event bridge, then the
// catch-all SSR last so it can read the resolved request context and never shadows real routes.
export const mount = (app: Express, ctx: MountContext): void => {
  // both dirs sit next to this server bundle (webpack copies them in): /static = hashed webpack bundles
  // + manifest.json; /public = static files copied from src/public (manifest loader, images)
  const staticDir = path.join(__dirname, "static");
  const publicDir = path.join(__dirname, "public");

  const serverConfig = ctx.settings ? serverConfigFromSettings(ctx.settings.web) : defaultServerConfig();
  app.use(configContextMiddleware(serverConfig));
  app.use(loggerContextMiddleware(ctx.logger));
  app.use(userContextMiddleware());

  app.use("/static", staticAssetsMiddleware(staticDir));
  app.use("/public", staticAssetsMiddleware(publicDir));
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/events", eventsSseMiddleware(ctx.bus, ctx.signal));

  app.get(/.*/, ssrRenderMiddleware());

  ctx.logger.debug?.("@agent-local/web mounted (config/logger/user + static + public + SSE /events + SSR)");
  ctx.signal.addEventListener("abort", () => ctx.logger.debug?.("@agent-local/web mount aborted"));
};
