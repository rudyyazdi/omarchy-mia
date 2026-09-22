# This file:

This file contains the guidelines for contributing to this codebase. It should not contain anything that is easy to lookup or it is likely to change. This file should be as short as possible, if a given statement should not be shortened in anyway without losing what it is conveying. A rule that tooling can check is enforced by `npm run check`, added in the same change that states it; prose here is for what tooling cannot check.

## Style

- No non-null assertions (`!`) and no type casts (`as T`, `<T>x`, `as unknown as`); when one is genuinely unavoidable (typically at an I/O boundary such as a SQLite row or `JSON.parse`), add `// eslint-disable-next-line <rule> -- <why>` on that one line so the reason is recorded.
- Internal types and variables are camelCase; snake_case appears only on wire-format payloads in `@mia/protocol` and on data received from the runtime, mapped once at the boundary.
- No single-letter identifiers, not even as arrow parameters (`(event) => event.id`, never `(e) => e.id`); `_` marks an ignored value.
- Standalone functions are arrow functions assigned to `const`; class methods stay methods. Functions take at most three parameters; pass an object beyond that.
- Dispatch on a discriminated union uses `match()` from ts-pattern with `.exhaustive()`, never `switch`. No nested ternaries.
- Use the platform: `Promise.withResolvers`, `import.meta.dirname`, `node:timers/promises`, iterator helpers. Node is pinned in `.node-version`.
- Command-line entry points use commander; do not parse `process.argv` by hand. A `main.ts` only parses arguments and calls an exported function; importing a module never runs an effect.

## Design

- Design for single responsibility: give each module one clear purpose and explicit, typed interfaces. Keep functions at one level of abstraction; extract cohesive responsibilities so each module has one reason to change.
- Give mutable state and resources one owner; expose state changes through explicit operations and clean up on partial failure and repeated shutdown.
- Prefer pure functions for decisions; push I/O to boundaries.
- Separate decisions, persistence, and effects.
- Make commit and effect ordering explicit; keep in-memory state consistent with committed records. Define behavior for duplicate requests, late callbacks, cancellation, and failures after commit.
- Favor extending behavior through stable contracts over modifying consumers; introduce abstractions for concrete needs, not speculative flexibility.
- Treat persisted formats and public protocols as compatibility contracts; make migrations and incompatible-version handling explicit.
- Make invalid states unrepresentable with discriminated unions. Each concept has one definition: a domain vocabulary (statuses, kinds, policies) is a union declared once and imported, never retyped as `string`; a helper has one home, never a second copy.
- Validate external data once at boundaries.
- Keep business rules independent of infrastructure.
- Make failure and partial-success behavior explicit.
- Test observable contracts and invariants, not implementation details. Test decisions with fast unit tests beside the module, and verify wiring and critical end-to-end invariants through acceptance tests.
- Keep dependencies directional (`docs/DEPENDENCIES.md`) and expose a module's contract by name, never its internals.
- Document non-obvious invariants and design tradeoffs near their owner; explain why, without restating the implementation.


## Documentation

- Nothing is repeated twice, every issue, task, guide or info should appear exactly once across any of the code, pr description or issue description.