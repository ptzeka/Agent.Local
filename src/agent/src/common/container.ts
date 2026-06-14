// typed service token: the phantom __type binds a token to its value type so get/set stay checked
export interface Token<T> {
  readonly key: symbol;
  readonly name: string;
  readonly __type?: T;
}

export function token<T>(name: string): Token<T> {
  return { key: Symbol(name), name };
}

// an (abstract) class whose instances are T; a class is its own runtime identity and carries its own name,
// so it needs no string label — unlike an interface, which compiles to nothing
type AbstractClass<T> = abstract new (...args: any[]) => T;

// a runtime handle for a service: a branded Token (string label) or a class reference (label from Ctor.name)
export type Handle<T> = Token<T> | AbstractClass<T>;

// chainable result of set(): .as() adds a singular alias (resolved by get), .by() adds group membership (collected by getAll)
// [T] extends [K] restricts both to a supertype, so a concrete service registers as an interface/base it implements, never the reverse
export interface RegisterChain<T> {
  as<K>(aliasToken: [T] extends [K] ? Token<K> : never): RegisterChain<T>;
  by<K>(group: [T] extends [K] ? Handle<K> : never): RegisterChain<T>;
}

// per-runtime service container: middleware set() services during build, every other consumer get()s them
// get() throws naming the handle, so an unmet dependency self-reports here instead of surfacing as undefined later
export class Container {
  private readonly instances = new Map<unknown, unknown>();
  // group membership is separate from singular resolution: many implementations of one interface/base collect here for getAll()
  private readonly groups = new Map<unknown, unknown[]>();

  set<T>(handle: Handle<T>, value: T): RegisterChain<T> {
    this.instances.set(this.keyOf(handle).key, value);
    return this.chainFor(value);
  }

  get<T>(handle: Handle<T>): T {
    const { key, name } = this.keyOf(handle);
    const value = this.instances.get(key);
    if (value === undefined) {
      throw new Error(`Container: no instance registered for "${name}"`);
    }
    return value as T;
  }

  tryGet<T>(handle: Handle<T>): T | undefined {
    return this.instances.get(this.keyOf(handle).key) as T | undefined;
  }

  has<T>(handle: Handle<T>): boolean {
    return this.instances.has(this.keyOf(handle).key);
  }

  // every value grouped under the handle via .by(), in registration order; empty array when none
  getAll<T>(group: Handle<T>): T[] {
    return (this.groups.get(this.keyOf(group).key) as T[] | undefined) ?? [];
  }

  // normalize a handle to its map key and human label: a Token keys by its symbol, a class keys by the constructor itself
  private keyOf<T>(handle: Handle<T>): { key: unknown; name: string } {
    if (typeof handle === "function") return { key: handle, name: handle.name };
    return { key: handle.key, name: handle.name };
  }

  private chainFor<T>(value: T): RegisterChain<T> {
    const chain: RegisterChain<T> = {
      as: <K>(aliasToken: [T] extends [K] ? Token<K> : never): RegisterChain<T> => {
        this.instances.set((aliasToken as Token<K>).key, value);
        return chain;
      },
      by: <K>(group: [T] extends [K] ? Handle<K> : never): RegisterChain<T> => {
        this.addToGroup(this.keyOf(group as Handle<K>).key, value);
        return chain;
      },
    };
    return chain;
  }

  private addToGroup(key: unknown, value: unknown): void {
    const group = this.groups.get(key);
    if (group) group.push(value);
    else this.groups.set(key, [value]);
  }
}
