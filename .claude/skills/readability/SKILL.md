---
name: readability
description: Make code speak for itself so comments aren't needed — name functions, returns, and variables so the call site reads as a sentence. Use when writing or reviewing a diff for naming, when tempted to add a comment that explains *what* code does, or when an inline expression needs a name. Complements AGENTS.md `## Comments` (which governs when a `//` is allowed) by removing the need for one.
---

# Readability in Agent.Local

The code is the documentation. A comment is the last resort, reached only after a
name has failed — and most of the time a better name is available. This skill is
about earning the right to delete the comment.

The companion is AGENTS.md `## Comments`: that section caps *when and how* a `//`
may exist (WHY only, single-line, line caps by scope). This skill is the other
half — write the code so you never need the `//` in the first place.

## 1 — A function's name and signature are its documentation

If you reach for a comment above a function to explain *what* it does, the
function is misnamed. Rename it until the comment is redundant, then delete the
comment.

- A surviving comment above a function states **why** it exists (a constraint, a
  decision) — never a paraphrase of its body. See AGENTS.md `## Comments`.
- Smell: `// resolves the model for the given role` sitting above
  `getModel(role)`. The comment is doing the naming the function should:
  `resolveModelForRole(role)`.

## 2 — Name the return, not the mechanic

The name describes the value that comes back, so the call site reads as a sentence.

- `resolveModelForRole(role)` over `getModel(role)`; `scopedClientsForRole(role)`
  over `build(role)`.
- A boolean returns the **claim** it asserts: `isStale`, `hasLease`,
  `canDispatch` — not `check()` / `status()`. `if (lease.isStale)` reads;
  `if (lease.check())` does not.
- Reference points already in the tree: `ScopedToolClient.forRole`,
  `ModelRegistry` role→model resolution. The names tell you the result without
  opening the body.

## 3 — Variables name the value, not the type or the temp

- No `tmp`, `data`, `arr`, `obj`, `res`, `x`. A `const` holds `scopedClients`,
  `pendingTurn`, `leaseHolder` — what it *is*.
- Abbreviate only domain terms with no settled long form (`token`, `mcp`,
  `signal`, `dto`). Everything else spelled out.
- A name that needs a trailing comment to disambiguate (`const n; // node count`)
  is the wrong name (`const nodeCount`).

## 4 — Extract to name

A well-named intermediate is cheaper documentation than a `//`. When an
expression needs explaining, give it a name instead of a comment.

```ts
// before — a comment compensating for an unnamed expression
// only dispatch when the lease is ours and not yet expired
if (lease.holder === self && lease.expiresAt > now) dispatch();

// after — the name carries the meaning, no comment needed
const holdsActiveLease = lease.holder === self && lease.expiresAt > now;
if (holdsActiveLease) dispatch();
```

- Same move for a `// what` comment mid-body: lift the block into a private method
  whose name is the comment. (Per the `solid` skill, behavior that touches the
  type's collaborators belongs in a method anyway.)
- Stop when extracting stops adding clarity — a single obvious expression doesn't
  need a name. Naming is the tool; readability is the goal.

## 5 — Structure reads top-down

- Order a function so the call site reads before the helper: the *what* first, the
  *how* below. A reader should understand a method before scrolling into its
  details.
- Keep one level of abstraction per function. A method that both decides policy
  *and* fiddles byte-level detail forces the reader to switch altitude mid-read —
  split it.

## 6 — Boy Scout: leave the function cleaner than you found it

When you touch a function for *any* reason — a fix, a feature, a review — bring its
naming and comments up to this skill as part of the same change. Readability debt
gets paid down where you already have the file open, not in a separate someday pass.

- **Scope to what you touched.** Clean the function (and its immediate
  collaborators) you're already editing — rename a misleading local, delete a
  `// what` comment a name now covers, fix a stale comment that no longer matches
  the code. Do **not** sweep the whole file or rename across the tree in an
  unrelated diff; an out-of-scope rename buries the real change in review.
- **Stale comment beats no comment in only one direction:** a comment that lies is
  worse than none. If you read one that no longer matches the code, fix it or
  delete it on the spot — never leave it for later.
- **A pure cleanup is its own commit.** When the readability pass is large or
  stands alone, separate it from behavior changes so each diff reviews cleanly.

## Review checklist

When writing or reviewing a diff, ask:
1. Could I delete every `// what` comment by renaming the thing it sits above? (1, 2)
2. Does each return name the value, with booleans as claims (`isX`/`hasX`)? (2)
3. Do variables name the value, free of `tmp`/`data`/`x` and disambiguating
   comments? (3)
4. Is every explained expression a named `const` or a named method instead of a
   comment? (4)
5. Does the function read top-down at one level of abstraction? (5)
6. For every function I touched, did I leave its names and comments cleaner than
   I found them, and fix any comment that no longer matches the code? (6)
