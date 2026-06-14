import { describe, expect, test } from "@jest/globals";

import { Container, token } from "../../src/common/container.js";

/**
 * Container business logic: a typed service locator keyed by branded tokens.
 * get() fails loud (naming the token) so an unmet dependency self-reports at the
 * gap instead of surfacing as a downstream `undefined`.
 */
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
});
