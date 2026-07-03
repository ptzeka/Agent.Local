import express, { type Request, type Response, type NextFunction } from "express";
import { sessionKey, type ILogger } from "@agent-local/common";
import { loadAuthSettings } from "./appsettings.js";
import { loadOrCreateKeyRing } from "./keys.js";
import { sessionMiddleware } from "./session.js";
import { createAuthApi } from "./auth-api.js";

const DEFAULT_PORT = 3015;

// CORS for the credentialed account routes: the web app is cross-origin from this IdP, so a credentialed fetch
// needs the exact requesting origin echoed back (never "*" with credentials) plus the credentials flag. Only
// allow-listed origins are echoed; a preflight OPTIONS short-circuits with 204.
function corsMiddleware(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

// console-backed ILogger: this service owns its process lifecycle, so it logs without FileLogger's filesystem
const logger: ILogger = {
  error: (message, ...args) => console.error(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
  info: (message, ...args) => console.info(message, ...args),
  debug: (message, ...args) => console.debug(message, ...args),
};

// standalone auth service (IdP): its own express app, sat behind the auth.peritze.com proxy. It owns the RS256
// key ring and every auth endpoint — /account/* (cookie session), /connect/token (OAuth grants), and the OIDC
// discovery + JWKS the host/agent verify against. No DB and no event bus: it only signs, verifies, and seals.
async function main(): Promise<void> {
  const settings = loadAuthSettings();
  const app = express();
  // load (or first-run generate) the RS256 key ring so /account/login and /connect/token can sign tokens
  const keys = loadOrCreateKeyRing();
  // the key that seals/opens the session cookie ticket; SHARED with the host (same appsettings secret) so the
  // host can open the ticket this service seals at login. local-only for now (see appsettings session.secret).
  if (!settings.session?.secret) logger.warn?.("[auth] no session.secret — session cookie uses an insecure dev key");
  const cookieKey = sessionKey(settings.session?.secret ?? "agent-local-insecure-dev-session-secret");

  app.use(express.json());
  // urlencoded: /connect/authorize's login form is a plain HTML <form> post (no JS needed on this IdP-hosted page)
  app.use(express.urlencoded({ extended: false }));
  // CORS before everything: the web app calls the account routes cross-origin with credentials, so the
  // allow-origin/credentials headers (and the OPTIONS preflight) must be in place ahead of the route handlers.
  app.use(corsMiddleware(settings.cors?.allowedOrigins ?? []));
  // liveness: the service is up and serving. cheap, dependency-free — orchestrators restart on its failure.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(sessionMiddleware(cookieKey));                            // decrypt the session cookie ONCE -> req.authTicket
  app.use(createAuthApi(keys, settings.iam, cookieKey, logger, settings.session?.cookieDomain, settings.nativeClients)); // /account/* + /connect/* + /.well-known/*
  logger.info("[auth] mounted account + connect + discovery routes");

  const port = Number(process.env.AUTH_PORT) || settings.port || DEFAULT_PORT;
  const server = app.listen(port, () => {
    logger.info(`[auth] listening on :${port}`);
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
