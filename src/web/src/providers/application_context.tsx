import React, { createContext, use, useContext, useMemo, useRef } from "react";
import type { ThemeName } from "../theme/theme";
import { miniStore, useMiniStore, type IMiniStore } from "../components/shared/miniStore";

export interface ILogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

// runtime configuration — sourced from appsettings (server injects it via WEBPACK_ENTRY_DATA, or the
// client fetches /appsettings.json when not yet initialized). Auth values are placeholder stubs today.
export interface IConfiguration {
  isSSR: boolean;
  initialized: boolean;
  environment: {
    name: string;
    applicationName: string;
  };
  authentication: {
    authorityUrl: string;
    clientId: string;
  };
  apiAddress: string;
  basePath: string;
}

export interface IApplicationContextType {
  $config: IMiniStore<IConfiguration>;
  // subscribable theme NAME; resolved to a MUI Theme by AppStart
  $theme: IMiniStore<ThemeName>;
  basePath: string;
  logger: ILogger;
  isSSR: boolean;
  title: string;
}

const DEFAULT_CONFIG: IConfiguration = {
  isSSR: false,
  initialized: false,
  environment: { name: "", applicationName: "Agent.Local" },
  authentication: { authorityUrl: "", clientId: "" },
  apiAddress: "",
  basePath: "",
};

export const ConsoleLogger: ILogger = {
  debug: (...args) => console.log(...args),
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

const DEFAULT_VALUE: IApplicationContextType = {
  $config: null as unknown as IMiniStore<IConfiguration>,
  $theme: miniStore.create<ThemeName>({ current: "light" }),
  basePath: "",
  isSSR: false,
  title: "Agent.Local Console",
  logger: ConsoleLogger,
};

// resolves config once: already-initialized (server-injected) short-circuits; otherwise fetch
// /appsettings.json. Returned promise feeds React 19 use() so SSR and first paint stay consistent.
const fetchConfigAsync = (config: IConfiguration, logger: ILogger): Promise<IConfiguration> => {
  return new Promise((resolve) => {
    if (config.initialized || typeof window === "undefined") {
      resolve({ ...config, initialized: true });
      return;
    }
    fetch("/appsettings.json")
      .then((r) => r.json())
      .then((a) => {
        resolve({
          ...config,
          environment: {
            name: a["environment"] ?? "",
            applicationName: a["applicationName"] ?? config.environment.applicationName,
          },
          authentication: {
            authorityUrl: a["authentication"]?.["authorityUrl"] ?? "",
            clientId: a["authentication"]?.["clientId"] ?? "",
          },
          apiAddress: a["apiAddress"] ?? "",
          basePath: a["basePath"] ?? "",
          initialized: true,
        });
      })
      .catch((e) => {
        logger.error("Failed to fetch appsettings.json", e);
        resolve({ ...config, initialized: true });
      });
  });
};

const ApplicationContext = createContext<IApplicationContextType>(DEFAULT_VALUE);

export const ApplicationContextProvider = ({
  value,
  children,
}: {
  value?: Partial<IApplicationContextType> & { config?: IConfiguration; theme?: ThemeName };
  children: React.ReactNode;
}): React.ReactElement => {
  const basePath = value?.basePath ?? "";
  const isSSR = value?.isSSR ?? false;
  const title = value?.title ?? DEFAULT_VALUE.title;
  const logger = value?.logger ?? ConsoleLogger;

  const seedConfig = value?.config ?? DEFAULT_CONFIG;
  const configPromise = useMemo(() => fetchConfigAsync(seedConfig, logger), [seedConfig, logger]);
  const configRef = useRef<IConfiguration>(use(configPromise));
  const $config = miniStore.create<IConfiguration>(configRef);

  // theme handle created once so it stays stable across renders; write via $theme.set() to switch
  const themeRef = useRef<ThemeName>(value?.theme ?? "light");
  const $theme = miniStore.create<ThemeName>(themeRef);

  logger.debug(`ApplicationContext initialized: ${$config.get().initialized}`);
  return (
    <ApplicationContext.Provider value={{ $config, $theme, basePath, isSSR, title, logger }}>
      {children}
    </ApplicationContext.Provider>
  );
};

export const useApplicationContext = () => useContext(ApplicationContext);
