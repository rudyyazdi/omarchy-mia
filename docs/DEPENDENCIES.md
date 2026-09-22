# Dependency direction

Imports point down the layers: nothing imports a layer above itself, and nothing imports a sibling in its own layer, so a module's dependencies can be read off its position alone.

Which workspace sits in which layer is the `LAYERS` list in [`eslint.config.js`](../eslint.config.js). That list is the source: `npm run lint` turns it into `no-restricted-imports` overrides and fails on an upward or cross-workspace import, while a table here could only ever agree with it by hand.

Layers 3 and 4 are entry points: only tests may import an app, and nothing imports a test or a tool.

## When to split

Split a module when it gains a second reason to change, when part of it needs a test the rest gets in the way of, or when a pure decision and the I/O around it share a file.

Split a package when a second consumer needs part of it without the rest of its dependencies, or when a part belongs in a lower layer than the whole.

Do not split for size alone, for symmetry, or for a consumer that does not exist yet.
