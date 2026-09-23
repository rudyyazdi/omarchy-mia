# This file:

This file contains the guidelines for contributing to this codebase. It holds nothing that is easy to look up or likely to change, and it is as short as possible: no statement can be shortened without losing what it conveys. `npm run check` enforces every rule here that tooling can check; the check lands in the same change as the rule, or that change links the issue that will add it.

## Style

- No non-null assertions (`!`) and no type casts (`as T`, `<T>x`, `as unknown as`); when one is genuinely unavoidable (typically at an I/O boundary such as a SQLite row or `JSON.parse`), add `// eslint-disable-next-line <rule> -- <why>` on that one line so the reason is recorded.
- No single-letter identifiers other than property names, not even as arrow parameters (`(event) => event.id`, never `(e) => e.id`); `_` marks an ignored value.
- Standalone functions are arrow functions assigned to `const`, and callbacks are arrow functions; class methods stay methods. Functions take at most three parameters; pass an object beyond that.
- Dispatch on a discriminated union uses `match()` from ts-pattern with `.exhaustive()`, never `switch`. No nested ternaries.

## Design

- Design for single responsibility: give each module one clear purpose and explicit, typed interfaces. Keep functions at one level of abstraction; extract cohesive responsibilities so each module has one reason to change.
- Give mutable state, resources and timers one owner; expose state changes through explicit operations and clean up on partial failure and repeated shutdown.
- Prefer pure functions for decisions; push I/O to boundaries, and pass the clock and randomness in as inputs.
- Separate decisions, persistence, and effects.
- Make commit and effect ordering explicit; keep in-memory state consistent with committed records. Define behavior for duplicate requests, late callbacks, cancellation, and failures after commit.
- Favor extending behavior through stable contracts over modifying consumers; introduce abstractions for concrete needs, not speculative flexibility.
- Make invalid states unrepresentable with discriminated unions. Each concept has one definition: a domain vocabulary (statuses, kinds, policies) is a union declared once and imported, never retyped as `string`; a helper has one home, never a second copy.
- Validate external data once at boundaries.
- Keep business rules independent of infrastructure.
- Make failure and partial-success behavior explicit.
- Keep dependencies directional (`docs/DEPENDENCIES.md`) and import another workspace by its package name, never by relative path. A workspace's `index.ts` lists its contract export by export, never `export *`, and exposes no internals.
- Document non-obvious invariants and design tradeoffs near their owner; explain why, without restating the implementation.

## Node

- Use the platform: `Promise.withResolvers`, `import.meta.dirname`, `node:timers/promises`, iterator helpers.
- Command-line entry points use commander; do not parse `process.argv` by hand. Only the file a process starts from (a `main.ts`, or a module a third-party host loads as a plugin) reads `process.env`, installs signal handlers or calls `process.exit`, never a test or config file; a `main.ts` parses arguments and passes what it read to an exported function. Importing any other module never runs an effect.
- Every promise is awaited, returned, or given a `.catch` that handles the failure; `void` only a promise that cannot reject. An async function is never passed where the caller ignores its result (signal and event handlers): an unhandled rejection exits the process.
- Synchronous I/O (`*Sync`) runs only before a process starts serving or in a one-shot command, never while a server or client is serving, because it stalls every connection. The SQLite catalog is the exception: `node:sqlite` is synchronous only, so keep each statement short. A function that blocks is itself named `*Sync`, so the bypass that says it runs before serving sits at each call to it.
- An operation that can run long (a turn, a child process, a network call) accepts an `AbortSignal` instead of creating its own deadline. The entry point builds deadlines (`AbortSignal.timeout`, combined with `AbortSignal.any`) and passes them down, so a test aborts the signal directly.
- Child processes start with `spawn`, `execFile` or their `Sync` forms and an argument array, never `exec`, `execSync` or `shell: true`.
- Every in-memory collection that grows (queues, caches, per-session maps, captured child output) has an explicit bound and a stated behavior when full. Output toward the user streams one complete record (a line, an event) at a time instead of being collected whole, and Node streams are connected with `pipeline` from `node:stream/promises` so backpressure holds.
- A timer that bounds or polls work never holds the process open (`AbortSignal.timeout` already does not; pass `{ ref: false }` to `node:timers/promises`; `unref()` a raw handle). Open connections, servers and child processes keep it alive.

## Testing

- Test observable contracts and invariants, not implementation details. Test decisions with fast unit tests beside the module, and verify wiring and critical end-to-end invariants through acceptance tests.
- A bug fix lands with a test that fails without the fix.
- A test waits on an event or a promise and moves time only with fake timers, never by waiting.
- Fake only the agent runtime and the network. Use a real temporary directory for the filesystem, the injected clock for code that reads the time, and fake timers for code that schedules on it; to observe an effect, inject the function that performs it instead of mocking its module.
- A test's temporary directories, servers and child processes are torn down by the test or hook that created them, even when the test fails; tests pass in any order.

## Documentation

- Every issue, guide or fact has one home among code, docs, this file, commit messages, PR descriptions and issue descriptions; everywhere else links to it. A lint rule's configuration and message may restate the rule here that it enforces.

## Agents

- Agents work in the sibling worktrees `../mia-a` to `../mia-d`, never in the main checkout and never in a fresh worktree. Take the first one that is clean and has no open PR, run `git fetch && git switch -C <branch> origin/main && npm install`, and leave it clean when the PR is merged.
