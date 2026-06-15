---
name: solid
description: Apply the project's SOLID conventions when writing or reviewing code — single responsibility per class, middleware-based extension, interchangeable implementations behind interfaces, and centralized DI via registries/Runtime. Use when adding a class/service, deciding where logic lives, introducing a second implementation, or reviewing a diff for design smells.
---

# SOLID in Agent.Local

How the five SOLID principles are expressed *in this codebase*. Each rule below
names the concrete anchor to follow — match the existing pattern, don't invent a
parallel one.

## S — Single Responsibility

A class manages one thing. A user class manages users, **not** user permissions.

- Split by concern, not by convenience. If a class title needs "and" to describe
  it, it is two classes.
- The registries are the model: `ConfigurationRegistry` owns `models.json`,
  `ModelRegistry` owns role→model resolution, `McpClientRegistry` is a neutral
  transport and nothing more. None reach into each other's job.
- Smell: a method that loads config *and* dispatches *and* filters by role. That
  is three responsibilities — see how the wiring refactor in
  [REGISTRY_PATTERN.md](../../../REGISTRY_PATTERN.md) pulled them apart.

## O — Open/Closed

Extend behavior by **chaining middleware**, not by editing existing logic.

- New behavior = a new pipeline step in
  [src/agent/src/agent/runtime/middleware/](../../../src/agent/src/agent/runtime/middleware/),
  composed in. Existing steps stay closed — their observable behavior must keep
  matching expectations.
- If you find yourself adding an `if` branch inside a stable class to special-case
  a new caller, stop: add a middleware/handler instead.
- Modify behavior, never silently change what existing behavior already promises.

## L — Liskov Substitution

Any important part must be swappable without callers noticing.

- A rendering engine should accept a different implementation (razor / mustache)
  behind the same contract. A substitute must honor the full contract — same
  pre/postconditions — not just the method signatures.
- The `Mcp` implementations are the reference: `LocalMcp` (in-process dispatch)
  and `McpClient` (external stdio) are interchangeable everywhere a `Mcp` is
  expected. Code against `Mcp`, never against the concrete class.

## I — Interface Segregation

Anything with more than one implementation gets an interface — ideally everything
important does.

- Pattern to copy: `Mcp` ([src/mcp/src/mcp.ts](../../../src/mcp/src/mcp.ts)) is the
  interface; `LocalMcp` and `McpClient` implement it. This keeps the two server
  kinds consistent and lets registries hold one type.
- Before adding a second concrete class, extract the interface first, then make
  both implement it. Don't let callers branch on which concrete class they got.

## D — Dependency Injection

No scattered stateless `createX()` factories. Stateless dependencies live in **one
place**, are registered into the DI container, and are distributed centrally.

- All stateless repositories/services belong in the registries folder
  ([src/agent/src/agent/registries/](../../../src/agent/src/agent/registries/)),
  registered via the container
  ([src/agent/src/agent/runtime/middleware/container.ts](../../../src/agent/src/agent/runtime/middleware/container.ts))
  and reached through Runtime getters — not constructed ad hoc.
- A function should **receive** its dependencies (from Runtime / the registry),
  not resolve or `new` them up itself. Random construction scattered across the
  project means no one can track who owns what.
- Smell: `new SomeService()` or a one-off `createSomeService()` deep inside a
  feature file. Route it through a registry instead.

## Review checklist

When writing or reviewing a diff, ask:
1. Does this class do exactly one job? (S)
2. Did we extend via middleware/composition instead of editing stable logic? (O)
3. Is every important type coded against its interface, with swappable impls? (L/I)
4. Are dependencies injected from Runtime/registries, not constructed inline? (D)
