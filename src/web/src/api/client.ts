import axios, { type AxiosInstance, type AxiosError } from "axios";

// base HTTP layer: one configured axios instance per app session. The provider owns the instance and
// resolves baseURL/token once; hooks and api fns consume it. No fetch/asJson scattered across callers.
export interface ApiClientOptions {
  // resolved from app config (apiAddress/basePath); empty string keeps calls same-origin relative
  baseURL: string;
  // read lazily so a token refreshed mid-session is picked up without rebuilding the instance
  getAccessToken: () => string | undefined;
}

// non-2xx becomes a thrown Error("<url> -> <status>") — preserves the shape the old asJson surfaced to the UI
function toError(err: AxiosError): Error {
  const url = err.config?.url ?? "";
  const status = err.response?.status ?? "ERR";
  return new Error(`${url} -> ${status}`);
}

export function createApiClient({ baseURL, getAccessToken }: ApiClientOptions): AxiosInstance {
  // withCredentials: the host scopes every call to the logged-in user via the same-origin session cookie
  const client = axios.create({ baseURL, withCredentials: true, headers: { "content-type": "application/json" } });

  client.interceptors.request.use((config) => {
    const token = getAccessToken();
    // Bearer is the seam for real oidc later; the cookie already authenticates today
    if (token && token !== "AccessTokenHidden") config.headers.set("authorization", `Bearer ${token}`);
    return config;
  });

  client.interceptors.response.use(
    (res) => res,
    (err: AxiosError) => Promise.reject(toError(err)),
  );

  return client;
}
