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

  test("getAll() collects every implementation aliased under one generic interface token", () => {
    // Repository<T> is the generic interface; each concrete repo registers under its own token
    // AND aliases the shared family token, so getAll(family) returns all implementations
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

    container.set(userRepoToken, userRepo).as(repositories);
    container.set(orderRepoToken, orderRepo).as(repositories);

    const all = container.getAll(repositories);
    expect(all).toHaveLength(2);
    expect(all).toEqual([userRepo, orderRepo]);
    // each concrete token still resolves on its own
    expect(container.get(userRepoToken)).toBe(userRepo);
    expect(container.get(orderRepoToken)).toBe(orderRepo);
  });

  test("a single instance can be aliased under multiple interface tokens by chaining .as()", () => {
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

    container.set(rwToken, device).as(readers).as(writers);

    expect(container.getAll(readers)).toEqual([device]);
    expect(container.getAll(writers)).toEqual([device]);
    expect(container.get(readers).read()).toBe("data");
  });

  test("getAll() returns an empty array when no implementations were registered", () => {
    const container = new Container();
    const empty = token<{ run(): void }>("plugins");

    expect(container.getAll(empty)).toEqual([]);
  });
});
