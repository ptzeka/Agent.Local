// typed service token: the phantom __type binds a token to its value type so get/set stay checked
export interface Token<T> {
  readonly key: symbol;
  readonly name: string;
  readonly __type?: T;
}

export function token<T>(name: string): Token<T> {
  return { key: Symbol(name), name };
}

// chainable result of set(): each .as() aliases the same instance under another (super)interface token
// [T] extends [K] restricts the alias to a supertype, so a concrete service resolves as an interface it implements, never the reverse
export interface AliasChain<T> {
  as<K>(aliasToken: [T] extends [K] ? Token<K> : never): AliasChain<T>;
}

// per-runtime service container: middleware set() services during build, every other consumer get()s them
// get() throws naming the token, so an unmet dependency self-reports here instead of surfacing as undefined later
export class Container {
  private readonly instances = new Map<symbol, unknown>();
  // every value aliased under a token also accumulates here, so all implementations of one interface can be collected via getAll()
  private readonly groups = new Map<symbol, unknown[]>();

  set<T>(token: Token<T>, value: T): AliasChain<T> {
    this.instances.set(token.key, value);
    const chain: AliasChain<T> = {
      as: <K>(aliasToken: [T] extends [K] ? Token<K> : never): AliasChain<T> => {
        this.alias(aliasToken as Token<K>, value);
        return chain;
      },
    };
    return chain;
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

  // all values aliased under the (interface) token, in registration order; empty array when none
  getAll<T>(groupToken: Token<T>): T[] {
    return (this.groups.get(groupToken.key) as T[] | undefined) ?? [];
  }

  // an alias is both singular (resolvable via get) and additive (collected by getAll), so one interface token serves both
  private alias<K>(aliasToken: Token<K>, value: unknown): void {
    this.instances.set(aliasToken.key, value);
    const group = this.groups.get(aliasToken.key);
    if (group) group.push(value);
    else this.groups.set(aliasToken.key, [value]);
  }
}
