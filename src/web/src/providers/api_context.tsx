import React, { createContext, useContext, useMemo } from "react";
import type { AxiosInstance } from "axios";
import { createApiClient } from "../api/client";
import { useApplicationContext } from "./application_context";
import { useUserContext } from "./user_context";

// owns the single axios instance for the app; resolves baseURL/token once so SSR and client agree.
// sits below UserContext (needs the access token) and above the pages that call the api.
export interface IApiContextType {
  client: AxiosInstance;
}

const ApiContext = createContext<IApiContextType | null>(null);

export const ApiContextProvider = ({ children }: { children: React.ReactNode }): React.ReactElement => {
  const { $config } = useApplicationContext();
  const { $accessToken } = useUserContext();

  // apiAddress is the configured host (empty -> same-origin relative); built once per config snapshot.
  // token read lazily inside the interceptor so a later refresh needs no rebuild.
  const baseURL = $config.get().apiAddress;
  const client = useMemo(
    () => createApiClient({ baseURL, getAccessToken: () => $accessToken.get() }),
    [baseURL, $accessToken],
  );

  return <ApiContext.Provider value={{ client }}>{children}</ApiContext.Provider>;
};

export const useApiClient = (): AxiosInstance => {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error("useApiClient must be used within ApiContextProvider");
  return ctx.client;
};
