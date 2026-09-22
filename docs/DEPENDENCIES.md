# Dependency direction

Imports point down the table. Nothing imports up, and nothing imports a sibling in its own layer.

| Layer | Workspaces                                            | May import          |
| ----- | ----------------------------------------------------- | ------------------- |
| 0     | `@mia/protocol`                                       | Node and npm only   |
| 1     | `@mia/records`, `@mia/mcp-http`                       | layer 0             |
| 2     | `@mia/agent-adapter`, `@mia/controlled-mcp` (fixture) | layers 0 to 1       |
| 3     | `apps/*`, `tools/*`                                   | layers 0 to 2       |
| 4     | `tests/*`                                             | anything            |

Layers 3 and 4 are entry points: only tests may import an app, and nothing imports a test or a tool.

The `LAYERS` list in `eslint.config.js` encodes this table as `no-restricted-imports` overrides, so `npm run lint` fails on an upward or cross-workspace import; change the table and that list together.

## When to split

Split a module when it gains a second reason to change, when part of it needs a test the rest gets in the way of, or when a pure decision and the I/O around it share a file.

Split a package when a second consumer needs part of it without the rest of its dependencies, or when a part belongs in a lower layer than the whole.

Do not split for size alone, for symmetry, or for a consumer that does not exist yet.
