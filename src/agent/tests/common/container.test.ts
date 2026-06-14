import { describe, expect, test } from "@jest/globals";

import { Container, token } from "../../src/common/container.js";

// a typed service locator keyed by branded tokens; get() fails loud (naming the token) so an unmet
// dependency self-reports at the gap instead of surfacing as a downstream `undefined`
describe("Container", () => {
  test("get() returns the value stored under the same token", () => {
    const container = new Container();
    const numberToken = token<number>("answer");

    container.set(numberToken, 42);

    expect(container.get(numberToken)).toBe(42);
  });

  test("two tokens of the same name are distinct identities — get() reads only its own", () => {
    const container = new Container();
    const first = token<string>("dup");
    const second = token<string>("dup");

    container.set(first, "first");
    container.set(second, "second");

    expect(container.get(first)).toBe("first");
    expect(container.get(second)).toBe("second");
  });

  test("get() throws naming the token when nothing is registered", () => {
    const container = new Container();
    const missing = token<string>("workspace");

    expect(() => container.get(missing)).toThrow(/no instance registered for "workspace"/);
  });

  test("tryGet() yields undefined for an absent token instead of throwing", () => {
    const container = new Container();
    const absent = token<string>("optional");

    expect(container.tryGet(absent)).toBeUndefined();
  });

  test("has() reflects registration without resolving the value", () => {
    const container = new Container();
    const present = token<string>("present");
    const absent = token<string>("absent");

    container.set(present, "x");

    expect(container.has(present)).toBe(true);
    expect(container.has(absent)).toBe(false);
  });

  test("set() overwrites a prior registration under the same token", () => {
    const container = new Container();
    const reused = token<string>("reused");

    container.set(reused, "old");
    container.set(reused, "new");

    expect(container.get(reused)).toBe("new");
  });

  test("set().as() aliases one instance under a same-typed second token", () => {
    const container = new Container();
    const primary = token<{ id: string }>("primary");
    const alias = token<{ id: string }>("alias");
    const instance = { id: "shared" };

    container.set(primary, instance).as(alias);

    // both tokens resolve to the very same reference
    expect(container.get(primary)).toBe(instance);
    expect(container.get(alias)).toBe(instance);
  });

  test("set().as() lets a concrete service resolve under an interface it implements", () => {
    interface Animal {
      legs: number;
    }
    // Dog IS-A Animal: the concrete type extends the interface, so aliasing is allowed
    interface Dog extends Animal {
      bark(): string;
    }

    const container = new Container();
    const dogToken = token<Dog>("dog");
    const animalToken = token<Animal>("animal");
    const rex: Dog = { legs: 4, bark: () => "woof" };

    container.set(dogToken, rex).as(animalToken);

    // resolving the supertype token yields the same concrete instance
    expect(container.get(animalToken)).toBe(rex);
    expect(container.get(dogToken).bark()).toBe("woof");
  });

  test("getAll() collects every member registered under a group token via .by()", () => {
    // Repository<T> is the generic interface; each concrete repo registers under its own token
    // AND joins the shared family group via .by(), so getAll(family) returns all implementations
    interface Repository<T> {
      all(): T[];
    }
    interface User {
      id: string;
    }
    interface Order {
      total: number;
    }

    const container = new Container();
    const repositories = token<Repository<unknown>>("repository");
    const userRepoToken = token<Repository<User>>("userRepository");
    const orderRepoToken = token<Repository<Order>>("orderRepository");

    const userRepo: Repository<User> = { all: () => [{ id: "u1" }] };
    const orderRepo: Repository<Order> = { all: () => [{ total: 10 }] };

    container.set(userRepoToken, userRepo).by(repositories);
    container.set(orderRepoToken, orderRepo).by(repositories);

    const all = container.getAll(repositories);
    expect(all).toHaveLength(2);
    expect(all).toEqual([userRepo, orderRepo]);
    // each concrete token still resolves on its own
    expect(container.get(userRepoToken)).toBe(userRepo);
    expect(container.get(orderRepoToken)).toBe(orderRepo);
  });

  test(".as() is singular and .by() is group — a base class handle needs no string label", () => {
    interface IUserRepository {
      findUser(): string;
    }
    // a real base class: its own runtime identity, so .by()/getAll() key off it directly with no string
    abstract class RepositoryBase {
      abstract name: string;
    }
    class UserRepository extends RepositoryBase implements IUserRepository {
      name = "users";
      findUser() {
        return "alice";
      }
    }

    const container = new Container();
    // an interface alias still needs a string label (interfaces vanish at runtime); the base class does not
    const iUserRepository = token<IUserRepository>("IUserRepository");
    const repo = new UserRepository();

    container.set(UserRepository, repo).as(iUserRepository).by(RepositoryBase);

    // the concrete class and the interface alias both resolve singularly via get()
    expect(container.get(UserRepository)).toBe(repo);
    expect(container.get(iUserRepository).findUser()).toBe("alice");
    // the base class is a grouping, reachable only through getAll() — keyed by the class, no string
    expect(container.getAll(RepositoryBase)).toEqual([repo]);
    // .by() does NOT make the base singularly resolvable
    expect(container.tryGet(RepositoryBase)).toBeUndefined();
    // .as() does NOT add the interface to a group
    expect(container.getAll(iUserRepository)).toEqual([]);
  });

  test("a class reference is a handle — keyed by identity, labeled by name, no string anywhere", () => {
    abstract class Plugin {
      abstract id(): string;
    }
    class AlphaPlugin extends Plugin {
      id() {
        return "alpha";
      }
    }
    class BetaPlugin extends Plugin {
      id() {
        return "beta";
      }
    }

    const container = new Container();
    const alpha = new AlphaPlugin();
    const beta = new BetaPlugin();

    // each concrete class resolves singularly; both join the base-class group via .by()
    container.set(AlphaPlugin, alpha).by(Plugin);
    container.set(BetaPlugin, beta).by(Plugin);

    expect(container.get(AlphaPlugin)).toBe(alpha);
    expect(container.get(BetaPlugin)).toBe(beta);
    // distinct classes are distinct keys — no collision despite a shared base
    expect(container.get(AlphaPlugin)).not.toBe(container.get(BetaPlugin));
    expect(container.getAll(Plugin)).toEqual([alpha, beta]);
  });

  test("get() by an unregistered class throws naming the class", () => {
    class Missing {}
    const container = new Container();

    expect(() => container.get(Missing)).toThrow(/no instance registered for "Missing"/);
  });

  test("an instance can join multiple groups by chaining .by()", () => {
    interface Reader {
      read(): string;
    }
    interface Writer {
      write(): void;
    }
    interface ReadWriter extends Reader, Writer {}

    const container = new Container();
    const rwToken = token<ReadWriter>("readWriter");
    const readers = token<Reader>("reader");
    const writers = token<Writer>("writer");
    const device: ReadWriter = { read: () => "data", write: () => {} };

    container.set(rwToken, device).by(readers).by(writers);

    expect(container.getAll(readers)).toEqual([device]);
    expect(container.getAll(writers)).toEqual([device]);
  });

  test("getAll() returns an empty array when no members were registered", () => {
    const container = new Container();
    const empty = token<{ run(): void }>("plugins");

    expect(container.getAll(empty)).toEqual([]);
  });
});
