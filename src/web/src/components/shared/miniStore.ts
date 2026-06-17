import { RefObject, useSyncExternalStore } from "react";

// subscribable single-value store: providers own the RefObject, components subscribe via useMiniStore.
// ported from the Rxo.Platform.Web.Sandbox frontend — the backbone of the provider pattern.
export interface IMiniStore<T> {
  unsub(callback: (t: T) => void): void;
  sub(callback: (t: T) => void): () => void;
  get(): T;
  set(t: T): void;
}

class MiniStore<T> implements IMiniStore<T> {
  private listeners = new Set<(t: T) => void>();
  private value: RefObject<T>;

  constructor(initialValue: RefObject<T>) {
    this.value = initialValue;
  }

  private notify() {
    [...this.listeners].forEach((cb) => cb(this.value.current));
  }

  public unsub = (callback: (t: T) => void): void => {
    this.listeners.delete(callback);
  };

  public sub = (callback: (t: T) => void): (() => void) => {
    this.listeners.add(callback);
    return () => this.unsub(callback);
  };

  public get = (): T => {
    return this.value.current;
  };

  public set(t: T): void {
    // Object.is guard: skip the notify when the reference is unchanged
    if (!Object.is(this.value.current, t)) {
      this.value.current = t;
      this.notify();
    }
  }
}

export const miniStore = {
  create<T>(initialValue: RefObject<T>) {
    return new MiniStore<T>(initialValue);
  },
};

type StoreValue<S> = S extends IMiniStore<infer T> ? T : never;
type StoreValues<Stores extends IMiniStore<unknown>[]> = {
  [K in keyof Stores]: StoreValue<Stores[K]>;
};

/**
 * Subscribe to one or more miniStore handles. Variadic in, array (tuple) out —
 * always destructure, even for a single store:
 *   const [theme] = useMiniStore($theme);
 *   const [token, config] = useMiniStore($accessToken, $config);
 */
export const useMiniStore = function <Stores extends IMiniStore<unknown>[]>(
  ...stores: [...Stores]
): StoreValues<Stores> {
  const results = stores.map((store) => useSyncExternalStore(store.sub, store.get, store.get));
  return results as StoreValues<Stores>;
};
