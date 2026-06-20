import { useCallback, useEffect, useRef, useState } from "react";

// the four phases a call moves through; pages gate UI off this rather than re-deriving from loading+error
export type ApiStatus = "idle" | "loading" | "success" | "error";

export interface ApiQueryState<T> {
  status: ApiStatus;
  loading: boolean;
  // true once the first call has settled (success OR error) — distinguishes "never ran" from "ran, empty"
  initialized: boolean;
  data: T | undefined;
  error: Error | undefined;
  refresh: () => Promise<void>;
}

// runs `fn` on mount and whenever `deps` change; re-runnable via refresh(). client-only: SSR never fetches.
export function useApiQuery<T>(fn: () => Promise<T>, deps: readonly unknown[]): ApiQueryState<T> {
  const [status, setStatus] = useState<ApiStatus>("idle");
  const [initialized, setInitialized] = useState(false);
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);

  // keep the latest fn without making it a dep — callers pass inline closures that change every render
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const refresh = useCallback(async (): Promise<void> => {
    if (typeof window === "undefined") return;
    setStatus("loading");
    setError(undefined);
    try {
      const result = await fnRef.current();
      setData(result);
      setStatus("success");
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setStatus("error");
    } finally {
      setInitialized(true);
    }
    // deps drive re-fetch; fnRef is intentionally excluded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, loading: status === "loading", initialized, data, error, refresh };
}

export interface ApiMutationState<A extends unknown[], T> {
  status: ApiStatus;
  loading: boolean;
  data: T | undefined;
  error: Error | undefined;
  run: (...args: A) => Promise<T | undefined>;
}

// imperative counterpart for POST actions (start/stop/continue/rerun); run() returns the result or undefined on error
export function useApiMutation<A extends unknown[], T>(fn: (...args: A) => Promise<T>): ApiMutationState<A, T> {
  const [status, setStatus] = useState<ApiStatus>("idle");
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);

  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async (...args: A): Promise<T | undefined> => {
    setStatus("loading");
    setError(undefined);
    try {
      const result = await fnRef.current(...args);
      setData(result);
      setStatus("success");
      return result;
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setStatus("error");
      return undefined;
    }
  }, []);

  return { status, loading: status === "loading", data, error, run };
}
