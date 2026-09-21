# Working in this repo

Style is enforced by `npm run check` (Prettier, ESLint, tsc, Vitest); CI runs the same and nothing merges red.

- No non-null assertions (`!`) and no type casts (`as T`, `<T>x`, `as unknown as`); when one is genuinely unavoidable (typically at an I/O boundary such as a SQLite row or `JSON.parse`), add `// eslint-disable-next-line <rule> -- <why>` on that one line so the reason is recorded.
- Internal types and variables are camelCase; snake_case appears only on wire-format payloads in `@mia/protocol` and on data received from the runtime, mapped once at the boundary.
- No single-letter identifiers, not even as arrow parameters (`(event) => event.id`, never `(e) => e.id`); `_` marks an ignored value.
- Standalone functions are arrow functions assigned to `const`; class methods stay methods. Functions take at most three parameters; pass an object beyond that.
- Dispatch on a discriminated union uses `match()` from ts-pattern with `.exhaustive()`, never `switch`. No nested ternaries.
- Use the platform: `Promise.withResolvers`, `import.meta.dirname`, `node:timers/promises`, iterator helpers. Node is pinned in `.node-version`.
- Command-line entry points use commander; do not parse `process.argv` by hand.
