import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "stream";
import type { Request, Response, NextFunction } from "express";
import { renderToPipeableStream } from "react-dom/server";
import { StaticRouter } from "react-router";
import { template } from "lodash";
import Root, { type Bootstrap } from "../../client/Root.js";

// the SSR shell is an index.html template copied next to the server bundle (webpack CopyPlugin), so the
// markup/head/manifest-bootstrap live in one editable file instead of hardcoded strings. Parsed once.
// __MODULE_URL__ is injected per bundle (DefinePlugin) so the runtime dir is correct in both CJS and ESM.
declare const __MODULE_URL__: string;
const moduleDir = path.dirname(fileURLToPath(__MODULE_URL__));
const renderShell = template(readFileSync(path.join(moduleDir, "index.html"), "utf-8"));

// escape <, >, & so the serialized bootstrap can't break out of the inline <script>
const serialize = (data: unknown): string =>
  JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

// the seeding shape handed to ApplicationContextProvider — built from req.serverConfig. Forces
// isSSR/initialized so the React 19 use() in ApplicationContext resolves synchronously (no first-paint fetch).
function GetApplicationContext(req: Request): Bootstrap["applicationContext"] {
  const { config, title, theme } = req.serverConfig;
  return {
    config: { ...config, isSSR: true, initialized: true },
    basePath: config.basePath,
    isSSR: true,
    title,
    theme,
  };
}

// the seeding shape handed to UserContextProvider — built from req.userContext (populated by
// userContextMiddleware); permissions reduced to the {key:true} map the provider expects.
function GetUserContext(req: Request): Bootstrap["userContext"] {
  const { accessToken, userInfo, permissions } = req.userContext;
  return {
    user: userInfo
      ? { userId: userInfo.userId, userName: userInfo.userName, firstName: userInfo.firstName, lastName: userInfo.lastName }
      : undefined,
    accessToken: accessToken ?? undefined,
    permissions: permissions.reduce<Record<string, boolean>>((acc, key) => ({ ...acc, [key]: true }), {}),
  };
}

// renders the index.html template and splits it at the <!--app--> marker so the head can flush before
// the React stream and the tail after it. The manifest bootstrap (head script) sets WEBPACK_ENTRY_DATA
// and loads the hashed client bundle; MUI injects its own <style> on hydration.
function shell(bootstrap: Bootstrap): { top: string; tail: string } {
  const { title, basePath } = bootstrap.applicationContext;
  const html = renderShell({
    title: title ?? "Agent.Local Console",
    state: serialize(bootstrap),
    entry: "app",
    basePath: basePath ?? "",
  });
  const [top, tail] = html.split("<!--app-->");
  return { top, tail };
}

// streams the React tree via renderToPipeableStream so first bytes flush before the full render settles
function flushBody(req: Request, res: Response): void {
  const bootstrap: Bootstrap = {
    applicationContext: GetApplicationContext(req),
    userContext: GetUserContext(req),
  };
  const { top, tail } = shell(bootstrap);
  let statusCode = 200;

  const writable = new Writable({
    write(chunk, _enc, next) {
      res.write(chunk);
      next();
    },
    final(next) {
      res.write(tail);
      res.end();
      next();
    },
  });

  const stream = renderToPipeableStream(
    <StaticRouter location={req.originalUrl}>
      <Root bootstrap={bootstrap} />
    </StaticRouter>,
    {
      onShellReady() {
        res.statusCode = statusCode;
        res.setHeader("Content-Type", "text/html");
        res.write(top);
        stream.pipe(writable);
      },
      onShellError() {
        statusCode = 500;
        req.logger.error?.("SSR shell error");
        if (!res.headersSent) res.status(500).send("SSR shell error");
      },
    },
  );
}

// catch-all SSR middleware: reads the request's resolved config + identity (config_context,
// user_context) and streams the console's HTML. Registered last so it never shadows API/static routes.
export function ssrRenderMiddleware() {
  return (req: Request, res: Response, _next: NextFunction): void => flushBody(req, res);
}
