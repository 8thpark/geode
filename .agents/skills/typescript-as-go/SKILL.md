---
name: typescript-as-go
description: Enforce agents to write TypeScript as if it were Go; simple, explicit, boring
license: MIT
compatibility: Designed for Claude Code (or similar products)
metadata:
  author: revett
  repo: https://github.com/revett/typescript-as-go
  version: 0.4.0
---

# TypeScript As Go

## Task

Write TypeScript as if it were Go: simple, explicit, boring. When you are unsure how to write
something, ask what the dullest Go programmer would do, and do that. The goal is code that is fast
to read and review, not clever to write. No magic.

## Rules

As an agent working in this project, you must follow the following allowed and banned rules when
writing Typescript.

### Allowed

1. Pure functions first, reaching for a class only where a framework contract demands one and
   keeping it a shell whose methods delegate immediately to module level functions; prefer
   composition over inheritance
2. Named exports only, using a default export solely when a framework requires it
3. Small files with one concern each and kebab-case file names (`settings-tab.ts`), graduating to
   package folders (`settings/tab.ts`) only once a concern outgrows a single *production* file
   (tests always sit beside their code, so they never on their own trigger the split); the folder's
   primary file repeats the package name (`vault/vault.ts`, like Go's `bytes/bytes.go`), never an
   `index.ts` barrel
4. Framework code stays thin glue, with logic living in pure modules that never import the framework
5. Names short and evocative, scaled to scope (terse for locals, descriptive for exports), never
   prefixing a getter with `get` (`owner()`, not `getOwner()`), never stuttering the enclosing
   package name in an exported symbol (`vault.Reader`, not `vault.VaultReader`), always camelCase or
   PascalCase and never snake_case
6. `type` over `interface` for data shapes, since they are structs not contracts and a `type` cannot
   be reopened by declaration merging; use `interface` only when a framework contract leaves no
   choice
7. String literal unions for closed sets of values (`type Status = "open" | "closed"`), keeping the
   syntax erasable at build time
8. Keep types small (one or two members) and accept the narrowest shape a function actually uses,
   since structural typing means callers need not name the type
9. Model variant data as a discriminated union with a shared literal tag, branching on the tag with
   a `switch` that ends in a `default` asserting the union is exhausted (`assertNever(x)`)
10. Use `satisfies` to check a value conforms to a type at compile time without widening it, the
    equivalent of Go's compile time interface check
11. Explicit zero values, where every type ships a complete default (a `DEFAULT_X` constant) usable
    as is without further initialization, never undefined shaped holes
12. Distinguish absent from zero with an explicit presence check (`map.has(k)`, `k in obj`,
    `x === undefined`), never reading a falsy default as "missing"
13. Errors are values, so domain logic returns a result the caller inspects (a tuple or
    `{ ok, value }`), never a sentinel like `-1`, `NaN`, `null`, or `""` folded into the normal
    return
14. Give a modeled error structure rather than just a string, carrying the operation, offending
    input, and any cause as fields, with lowercase messages that have no trailing period and are
    prefixed with their origin (`settings: unknown theme "$name"`)
15. Guard clauses and early returns, since flat beats nested
16. Braces on every `if`, even a one line body
17. Release resources with `try/finally` or a `using` declaration placed right where the resource is
    acquired, so cleanup sits beside setup and cannot be forgotten on an early return
18. One sentence `//` doc comment above every exported symbol, Go style
    (`// normalizeSettings returns ...`)
19. Table driven tests with `node:test` and `node:assert/strict` and no test framework dependency,
    each test sitting beside the code it covers as `name.test.ts`, mirroring Go's `_test.go` pattern
20. Reach for a small, focused dependency when hand rolling something fiddly to get right (request
    signing, a mock server), but hand roll the moment it drags in a framework or SDK you do not need
21. Separate a trailing `return` from the block above it with a blank line, so the final result of a
    function reads as its own beat rather than crowding the guard or loop that precedes it
22. The formatter, if there is one configured (e.g. Biome), is law, it decides and nobody debates
    the output

### Banned

1. No enums, use string literal unions instead
2. No ternary expressions, and no defaulting through `??` or `||`; write the `if`, or reach for a
   file local helper such as `stringOr(v, fallback)` or `numberOr(v, fallback)`, so the fallback is
   an explicit branch and not folded into an operator (`||` stays fine inside a boolean condition)
3. No `else` after a `return`
4. No `switch` case fallthrough, every case ending in `return` or `break`, with stacked labels to
   share a branch
5. No throwing for expected failures, returning the error as a value and converting to a result at
   the framework boundary, reserving `throw` (Go's `panic`) for impossible states and programmer
   errors and never exposing it across a module boundary as an API
6. No swallowed errors and no floating promises, never discarding an error or unhandled rejection
   you could handle
7. No sentinel or in band return values (`-1`, `null`, `NaN`, `""`) to signal failure or absence
8. No `interface` for plain data shapes
9. No JSDoc `/** */` blocks, use `//` comments
10. No barrel files and no `utils.ts` (or any grab bag dumping ground)
11. No inheritance for code reuse (`extends` chains), compose instead
12. No clever generics
13. No decorators
14. No magic
15. No chained array pipelines (`.filter().map()`, `.map().filter()`) and no `.reduce`; Go has no
    map or filter, so write an explicit `for...of` that guards with `continue` and pushes into a
    result, one readable loop over a pipeline (a single `.map` on an already clean list is fine)
