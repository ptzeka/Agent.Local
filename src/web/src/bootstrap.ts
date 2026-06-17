import type { Bootstrap } from "./client/Root";
import type { IConfiguration } from "./providers/application_context";

// server-side default bootstrap. Auth/config values are placeholder stubs today; they will be sourced
// from appsettings (env-driven) as the console matures. Marked initialized so the React 19 use() in
// ApplicationContext resolves synchronously during SSR and on hydration (no first-paint fetch).
export function defaultConfig(overrides: Partial<IConfiguration> = {}): IConfiguration {
  return {
    isSSR: true,
    initialized: true,
    environment: { name: process.env.NODE_ENV ?? "local", applicationName: "Agent.Local" },
    authentication: { authorityUrl: "", clientId: "" },
    apiAddress: "",
    basePath: "",
    ...overrides,
  };
}

export function defaultBootstrap(): Bootstrap {
  return {
    applicationContext: { config: defaultConfig(), isSSR: true, title: "Agent.Local Console", theme: "light" },
    userContext: {},
  };
}

// global injected by the SSR shell and read by the client entry to seed the same first render
declare global {
  interface Window {
    WEBPACK_ENTRY_DATA?: Bootstrap;
  }
}
