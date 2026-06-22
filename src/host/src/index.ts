import express from "express";
import { Eventing, sessionKey, AccessTokenProvider, type ILogger } from "@agent-local/common";
import { openDatabase } from "@agent-local/common/db";
import { resolveHostDbFile } from "./db/db-schema.js";
import { mount as mountWorkflow, WORKFLOW_TEMPLATES } from "@agent-local/temporal";
import { mount as mountWeb } from "@agent-local/web";
import { type MountContext } from "./mount.js";
import { loadAppSettings } from "./appsettings.js";
import { HttpEventReceiver } from "./comms/receiver.js";
import { createWorksApi } from "./api/works.js";
import { sessionMiddleware, resolveUserFromRequest } from "./user/session.js";
import { userContextMiddleware, requirePermission } from "./user/userContext.js";
import { createJwksProvider } from "./user/jwks.js";
import { HttpJobSender } from "./comms/sender.js";
import { WorkService } from "./services/work-service.js";
import { WorkStore } from "./work/work-store.js";
import { createHealthApi } from "./health.js";

const DEFAULT_PORT = 3011;

// console-backed ILogger: the host owns the process lifecycle, so it logs without depending on FileLogger's filesystem
const logger: ILogger = {
  error: (message, ...args) => console.error(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
  info: (message, ...args) => console.info(message, ...args),
  debug: (message, ...args) => console.debug(message, ...args),
};

async function main(): Promise<void> {
  // cancellation token
  const root = new AbortController();
  // event bus
  const bus = new Eventing();
  const app = express();
  const settings = loadAppSettings();
  if (!settings.host.session?.secret) logger.warn?.("[host] no host.session.secret — session cookie uses an insecure dev key");
  const cookieKey = sessionKey(settings.host.session?.secret ?? "agent-local-insecure-dev-session-secret");
  const db = openDatabase(resolveHostDbFile(settings.host.db?.file));
  const works = WorkStore.create(db);
  const ctx: MountContext = { bus, logger, signal: root.signal, settings, works, db, resolveUser: resolveUserFromRequest };

  app.use(express.json());
  // liveness: the host process is up and serving. cheap, dependency-free — orchestrators restart on its failure.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // verify bearers against the auth service's JWKS (auth is the issuer); options pin the issuer/audience the
  // token must carry. authority is the same issuerUrl auth stamps, so its discovery/jwks live under it.
  const getKey = createJwksProvider(settings.host.iam?.issuerUrl || "", logger);
  const verifyOptions = { issuer: settings.host.iam?.issuerUrl || undefined, audience: settings.host.iam?.audience || undefined };

  app.use(sessionMiddleware(cookieKey));                            // decrypt the session cookie ONCE -> req.authTicket
  app.use(userContextMiddleware(getKey, verifyOptions, logger));    // resolve identity: bearer (verified) over ticket
  app.use(new HttpEventReceiver(bus, logger).routes());            // POST /receive -> republish onto the bus
  // the host calls the agent under its OWN service identity (client-credentials -> agent:trigger), so dispatch
  // never depends on the caller's token and no JWT rides a process variable. one cached provider, shared by the
  // dispatch path and the readiness probe so both present the SAME bearer and refresh it only past expiry.
  const dispatchTokens = new AccessTokenProvider(logger);
  if (settings.host.dispatch) dispatchTokens.register(settings.host.dispatch);
  const dispatchClientId = settings.host.dispatch?.clientId;
  const sender = new HttpJobSender(bus, settings.agent.baseUrl, logger, dispatchTokens, dispatchClientId);
  sender.start();                                                   // workflow.job -> HTTP -> agent service
  // the work service owns the work unit: trigger provisions it, the bus updaters fold engine events onto jobs
  const workService = new WorkService(bus, works, sender, logger);
  workService.start();
  // gate the whole /workflow surface on the caller's session: reads need workflow:read, writes workflow:write;
  // liveness (/workflow/healthz) stays public. Mounted before the routes so it covers the engine routes.
  app.use("/workflow", (req, res, next) => {
    if (req.path === "/healthz") return next();
    return requirePermission(req.method === "GET" ? "workflow:read" : "workflow:write")(req, res, next);
  });
  // temporal bridge first so its read seam (client.getSteps) feeds the work API's step-history fold; both stay
  // before web, whose SSR catch-all would otherwise shadow /workflow and /api/works.
  const temporal = mountWorkflow(app, ctx);  // /workflow/* routes + Temporal client (publishes workflow.*)
  // the user-scoped work API: get/search/create/stop over the registry, each route owned by the cookie identity.
  // create runs the trigger flow; this replaces the old anonymous /workflow/trigger.
  app.use(createWorksApi(workService, works, db, WORKFLOW_TEMPLATES, logger, (workId) => temporal.getSteps(workId)));
  // readiness (/health/ready): the host can actually serve work — engine reachable (TCP connect to its frontend)
  // AND a live probe of the separate agent service. registered before web (whose SSR catch-all would shadow it).
  // distinct from /healthz liveness: a down dependency is unready, not dead. engine address is env-only, same as
  // the Temporal SDK reads it (TEMPORAL_ADDRESS for the gRPC frontend).
  app.use(createHealthApi({
    engineAddress: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
    agentBaseUrl: settings.agent.baseUrl,
    // the readiness probe authenticates to the agent under the host's OWN service identity (same cached provider)
    getServiceToken: () => (dispatchClientId ? dispatchTokens.getAccessTokenAsync(dispatchClientId) : Promise.resolve(null)),
    logger,
  }));
  mountWeb(app, ctx);       // React SSR: /static, /public, then the SSR catch-all (last)
  logger.info("[host] wired comms sender + receiver, mounted workflow, web");

  const port = Number(process.env.PORT) || settings.host.port || DEFAULT_PORT;
  const server = app.listen(port, () => {
    logger.info(`[host] listening on :${port}`);
  });

  const shutdown = (): void => {
    root.abort("process-shutdown");
    server.close(() => {
      try {
        db.close();
      } catch {
        // teardown must keep unwinding
      }
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
