// typed service token: the phantom __type binds a token to its value type so get/set stay checked
export interface Token<T> {
  readonly key: symbol;
  readonly name: string;
  readonly __type?: T;
}


export function token<T>(name: string): Token<T> {
  return { key: Symbol(name), name };
}

// per-runtime service container: middleware set() services during build, every other consumer get()s them
// get() throws naming the token, so an unmet dependency self-reports here instead of surfacing as undefined later
export class Container {
  private readonly instances = new Map<symbol, unknown>();

  // .as() aliases the SAME instance under a second token; the conditional restricts the alias to a
  // supertype token ([T] extends [K]), so a concrete service may resolve as an interface it implements, never the reverse
  set<T>(token: Token<T>, value: T): { as<K>(aliasToken: [T] extends [K] ? Token<K> : never): void } {
    const ref = this.instances;
    ref.set(token.key, value);
    return {
      as<K>(aliasToken: [T] extends [K] ? Token<K> : never): void {
        ref.set((aliasToken as Token<K>).key, value);
      },
    };
  }

  get<T>(token: Token<T>): T {
    const value = this.instances.get(token.key);
    if (value === undefined) {
      throw new Error(`Container: no instance registered for "${token.name}"`);
    }
    return value as T;
  }

  tryGet<T>(token: Token<T>): T | undefined {
    return this.instances.get(token.key) as T | undefined;
  }

  has<T>(token: Token<T>): boolean {
    return this.instances.has(token.key);
  }
}
