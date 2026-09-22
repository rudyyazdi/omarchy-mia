# This file:

This file contains the guidlines for contributing to this codebase. It should not contain anything that is easy to lookup or it is likely to change.

## Style

- No non-null assertions (`!`) and no type casts (`as T`, `<T>x`, `as unknown as`); when one is genuinely unavoidable (typically at an I/O boundary such as a SQLite row or `JSON.parse`), add `// eslint-disable-next-line <rule> -- <why>` on that one line so the reason is recorded.
- Internal types and variables are camelCase; snake_case appears only on wire-format payloads in `@mia/protocol` and on data received from the runtime, mapped once at the boundary.
- No single-letter identifiers, not even as arrow parameters (`(event) => event.id`, never `(e) => e.id`); `_` marks an ignored value.
- Standalone functions are arrow functions assigned to `const`; class methods stay methods. Functions take at most three parameters; pass an object beyond that.
- Dispatch on a discriminated union uses `match()` from ts-pattern with `.exhaustive()`, never `switch`. No nested ternaries.
- Use the platform: `Promise.withResolvers`, `import.meta.dirname`, `node:timers/promises`, iterator helpers. Node is pinned in `.node-version`.
- Command-line entry points use commander; do not parse `process.argv` by hand.

## Design

- Design for single responsibility: give each module one clear purpose and explicit, typed interfaces.
- Prefer pure functions for decisions; push I/O to boundaries.
- Separate decisions, persistence, and effects.
- Favor extending behavior through stable contracts over modifying consumers; introduce abstractions for concrete needs, not speculative flexibility.
- Make invalid states unrepresentable with discriminated unions.
- Validate external data once at boundaries.
- Keep business rules independent of infrastructure.
- Make failure and partial-success behavior explicit.
- Test observable contracts and invariants, not implementation details.
- Keep dependencies directional and avoid exposing internal representations across module boundaries.