import type { Request, Response, NextFunction } from "express";
import type { WebSettings } from "@agent-local/common";
import type { ThemeName } from "../../theme/theme";
import type { IConfiguration } from "../../providers/application_context";
import { defaultConfig } from "../../bootstrap";

// the server-side application config — the raw shape the host hands the console. Today the values are
// placeholder stubs (defaultConfig); they will be sourced from appsettings/env as the console matures.
export interface IApplicationConfig {
  config: IConfiguration;
  title: string;
  theme: ThemeName;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      serverConfig: IApplicationConfig;
    }
  }
}

export function defaultServerConfig(overrides: Partial<IApplicationConfig> = {}): IApplicationConfig {
  return {
    config: defaultConfig(),
    title: "Agent.Local Console",
    theme: "light",
    ...overrides,
  };
}

// the real source: maps the host's appsettings `web` section onto the console's request config, so SSR
// seeds the same values the client would otherwise fetch from /appsettings.json. Replaces the stub above.
export function serverConfigFromSettings(web: WebSettings): IApplicationConfig {
  return {
    config: defaultConfig({
      basePath: web.basePath,
      apiAddress: web.apiAddress,
      authentication: { authorityUrl: web.oauth.authorityUrl, clientId: web.oauth.clientId },
    }),
    title: web.title,
    theme: web.theme as ThemeName,
  };
}

// attaches the resolved server config to every request so downstream middleware (user_context,
// ssr_render) read one source of truth instead of re-reading appsettings per request.
export function configContextMiddleware(config: IApplicationConfig) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.serverConfig = config;
    next();
  };
}
