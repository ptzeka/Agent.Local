import type { Request, Response, NextFunction } from "express";
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

// attaches the resolved server config to every request so downstream middleware (user_context,
// ssr_render) read one source of truth instead of re-reading appsettings per request.
export function configContextMiddleware(config: IApplicationConfig) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.serverConfig = config;
    next();
  };
}
