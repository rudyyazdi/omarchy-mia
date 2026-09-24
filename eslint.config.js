import comments from "@eslint-community/eslint-plugin-eslint-comments";
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

const BYPASS_NOTE = "Bypass with an eslint-disable-next-line comment that carries a `-- reason`.";

// The dependency layers, lowest layer first. A layer may import the layers above it in this list,
// never one below it and never a sibling in its own layer. Why the direction matters, and when to
// split a module or a package instead of reaching across it: docs/DEPENDENCIES.md.
const LAYERS = [
  {
    files: ["packages/protocol/**", "packages/kernel/**"],
    workspaces: ["@mia/protocol", "@mia/kernel"],
    mayImportAnything: false,
  },
  {
    files: ["packages/records/**", "packages/mcp-http/**"],
    workspaces: ["@mia/records", "@mia/mcp-http"],
    mayImportAnything: false,
  },
  {
    files: ["packages/agent-adapter/**", "fixtures/controlled-mcp/**"],
    workspaces: ["@mia/agent-adapter", "@mia/controlled-mcp"],
    mayImportAnything: false,
  },
  {
    files: ["apps/*/**", "tools/*/**"],
    workspaces: ["@mia/server", "@mia/text-client", "@mia/debug-cli", "@mia/probe"],
    mayImportAnything: false,
  },
  // Layer 4: tests are the top layer and forbid nothing, so they get no override.
  {
    files: ["tests/*/**"],
    workspaces: ["@mia/acceptance", "@mia/fake-claude"],
    mayImportAnything: true,
  },
];

const forbidWorkspace = (name, reason) => ({
  group: [name, `${name}/*`],
  message: `${name} is ${reason}; imports only point down. See docs/DEPENDENCIES.md.`,
});

const FORBID_CROSS_WORKSPACE_RELATIVE = {
  group: ["../../*", "../../**"],
  message: "Cross-workspace relative import; import the package by name. See docs/DEPENDENCIES.md.",
};

const layerOverrides = LAYERS.flatMap((layer, index) =>
  layer.mayImportAnything
    ? []
    : [
        {
          files: layer.files,
          rules: {
            "no-restricted-imports": [
              "error",
              {
                patterns: [
                  ...layer.workspaces.map((name) =>
                    forbidWorkspace(name, "a sibling in the same layer"),
                  ),
                  ...LAYERS.slice(index + 1)
                    .flatMap((higher) => higher.workspaces)
                    .map((name) => forbidWorkspace(name, "a higher layer")),
                  FORBID_CROSS_WORKSPACE_RELATIVE,
                ],
              },
            ],
          },
        },
      ],
);

// @mia/kernel has no dependencies at all (#132): its source imports only node: modules and its own files, so the
// order it enforces cannot come to depend on Mia's domain or on a library. Its tests may import vitest.
const KERNEL_NO_DEPENDENCIES = {
  files: ["packages/kernel/**"],
  ignores: ["**/*.test.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            regex: "^(?!node:|\\./|\\.\\./)",
            message:
              "@mia/kernel has no dependencies; import only node: modules and its own files. See docs/DEPENDENCIES.md.",
          },
          FORBID_CROSS_WORKSPACE_RELATIVE,
        ],
      },
    ],
  },
};

// Enforces AGENTS.md, Design: a domain vocabulary is a union declared once and imported, never retyped as
// `string`. Lint sees only names, so a field that is meant to stay open (a value the runtime reports) takes a
// bypass that says so; a union spelled out twice, and fields named `type`, are left to review.
const VOCABULARY_WORDS = [
  "status",
  "kind",
  "policy",
  "role",
  "disposition",
  "mode",
  "relation",
  "decision",
  "effort",
  "integrity",
  "cancellation",
];
const capitalized = (word) => word[0].toUpperCase() + word.slice(1);
// snake_case (`status`, `capture_status`, `connection_state`) or camelCase (`captureStatus`, `connectionState`);
// case-sensitive, so `estate` or `correlation` is not a vocabulary name.
const VOCABULARY_NAME = `/(^|_)(${VOCABULARY_WORDS.join("|")})$|_state$|[a-z](${[...VOCABULARY_WORDS, "state"].map(capitalized).join("|")})$/`;
const KEY = [`[key.name=${VOCABULARY_NAME}]`, `[key.value=${VOCABULARY_NAME}]`];
const STRING_TYPE = [
  "TSStringKeyword",
  "TSUnionType > TSStringKeyword",
  "TSArrayType > TSStringKeyword",
];
// `z.string()`, alone or followed by up to two chained calls such as `.max(32).optional()`.
const Z_STRING = [
  'CallExpression[callee.object.name="z"][callee.property.name="string"]',
  'CallExpression[callee.object.callee.object.name="z"][callee.object.callee.property.name="string"]',
  'CallExpression[callee.object.callee.object.callee.object.name="z"][callee.object.callee.object.callee.property.name="string"]',
];
const Z_ARRAY_OF_STRING = Z_STRING.map(
  (call) => `CallExpression[callee.object.name="z"][callee.property.name="array"] > ${call}`,
);
const VOCABULARY_AS_STRING = {
  selector: [
    ...["TSPropertySignature", "PropertyDefinition"].flatMap((node) =>
      KEY.flatMap((key) => STRING_TYPE.map((type) => `${node}${key} > TSTypeAnnotation > ${type}`)),
    ),
    ...STRING_TYPE.map(
      (type) => `Identifier[name=${VOCABULARY_NAME}] > TSTypeAnnotation > ${type}`,
    ),
    `TSTypeAliasDeclaration[id.name=${VOCABULARY_NAME}] > TSStringKeyword`,
    ...KEY.flatMap((key) =>
      [...Z_STRING, ...Z_ARRAY_OF_STRING].map((call) => `Property${key} > ${call}`),
    ),
  ].join(", "),
  message: `A domain vocabulary (status, kind, policy, mode, effort, ...) is a union declared once and imported, never \`string\`. ${BYPASS_NOTE}`,
};

const RESTRICTED_SYNTAX = [
  VOCABULARY_AS_STRING,
  {
    selector: "FunctionDeclaration",
    message: `Use an arrow function assigned to a const. ${BYPASS_NOTE}`,
  },
  {
    selector:
      "FunctionExpression:not(MethodDefinition > FunctionExpression):not(Property[method=true] > FunctionExpression)",
    message: `Use an arrow function. ${BYPASS_NOTE}`,
  },
  { selector: "SwitchStatement", message: `Use match() from ts-pattern. ${BYPASS_NOTE}` },
  {
    // Importing the module would hide process.env and friends from no-restricted-properties.
    selector: "ImportDeclaration[source.value=/^(node:)?process$/]",
    message: `Use the \`process\` global instead of importing it. ${BYPASS_NOTE}`,
  },
];

// Source files outside tests: everything above, plus the rules that only apply to shipped code.
const SOURCE_RESTRICTED_SYNTAX = [
  ...RESTRICTED_SYNTAX,
  {
    selector: 'NewExpression[callee.name="Promise"]',
    message: `Use Promise.withResolvers, AbortSignal.timeout or once(). ${BYPASS_NOTE}`,
  },
];

// Enforces AGENTS.md, Node: synchronous I/O stalls every connection, so it runs only before a process starts
// serving. Lint cannot tell when a call runs, so each one that runs before serving says so in a bypass. The
// SQLite catalog's statement calls are the documented exception and match no selector. A function that blocks
// is itself named `*Sync`, so the bypass sits at each call to it, where "runs before serving" can be verified:
// a call directly in the body of a synchronous `*Sync` function or method is exempt, but not one in a callback
// it creates, which may run later. Lint sees a call by its name: a renamed or passed-along `*Sync` function, and
// a caller of a function that still blocks without the suffix (the rows #53 has yet to move off the serving
// path), are left to review.
const SYNC_NAME = "/Sync$/";
const SYNC_FUNCTIONS = [
  `VariableDeclarator[id.name=${SYNC_NAME}] > ArrowFunctionExpression[async=false]`,
  `MethodDefinition[kind="method"][key.name=${SYNC_NAME}] > FunctionExpression[async=false]`,
];
const SYNC_CALLS = [
  `CallExpression[callee.name=${SYNC_NAME}]`,
  `CallExpression[callee.property.name=${SYNC_NAME}]`,
  `NewExpression[callee.name=${SYNC_NAME}]`,
];
const NO_SYNC_IO = {
  selector: SYNC_CALLS.flatMap((call) => [
    `${call}:not(${SYNC_FUNCTIONS.map((fn) => `${fn} *`).join(", ")})`,
    ...SYNC_FUNCTIONS.map((fn) => `${fn} :function ${call}`),
  ]).join(", "),
  message: `Synchronous I/O stalls every connection; use node:fs/promises or an async child process. A call that runs before serving takes a bypass that says so (\`-- runs before serving\`); a function that blocks is named \`*Sync\` so each call to it is checked instead. ${BYPASS_NOTE}`,
};

// The workspaces that serve: the server, the libraries it runs, and the text client. Left out are one-shot
// processes (the debug CLI, the runtime's hook script) and code whose only client is a runtime it spawned
// itself (the probe, tests and their fixtures), where a stall holds up nobody else.
const SERVING_WORKSPACES = ["packages", "apps/server", "apps/text-client"];
const SERVING_FILES = SERVING_WORKSPACES.map((workspace) => `${workspace}/**/*.{ts,js,mjs}`);
const NOT_SERVING_FILES = ["**/*.test.ts", "packages/agent-adapter/src/hook-capture.mjs"];

// Enforces AGENTS.md, Node: only the file a process starts from reads the environment, installs
// signal handlers or exits; every other module takes what it needs as an argument.
const PROCESS_ENTRY_ONLY = [
  ...[
    "env",
    "exit",
    "exitCode",
    "on",
    "once",
    "addListener",
    "prependListener",
    "prependOnceListener",
  ].map((property) => ({
    object: "process",
    property,
    message: `Only the file a process starts from (a main.ts, or a module a host loads as a plugin) uses process.${property}; take the value as an argument or return it to the entry point. ${BYPASS_NOTE}`,
  })),
  {
    object: "globalThis",
    property: "process",
    message: `Use the \`process\` global, which the process-entry rule checks. ${BYPASS_NOTE}`,
  },
];

// The files a process starts from other than a main.ts: the runtime's hook script and the promptfoo
// provider plugin. The override below turns no-restricted-properties off for them, which only
// carries PROCESS_ENTRY_ONLY.
const PROCESS_ENTRY_FILES = [
  "**/main.ts",
  "packages/agent-adapter/src/hook-capture.mjs",
  "tests/acceptance/promptfoo/provider.ts",
];

// Enforces AGENTS.md, Design: `export *` makes every helper a module exports public contract.
const NO_EXPORT_ALL = {
  selector: "ExportAllDeclaration",
  message: `A workspace's index.ts lists its contract export by export; replace \`export *\` with the names other workspaces import. ${BYPASS_NOTE}`,
};

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      "dist/",
      "**/node_modules/",
      ".mia-work/",
      ".mia-state/",
      "tests/acceptance/promptfoo/output/",
    ],
  },
  {
    // Every linted file, whatever its extension: a bypass names the rules it silences and says why.
    plugins: { "@eslint-community/eslint-comments": comments },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "@eslint-community/eslint-comments/require-description": [
        "error",
        { ignore: ["eslint-enable"] },
      ],
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
    },
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  prettier,
  {
    files: ["**/*.ts", "**/*.js", "**/*.mjs"],
    languageOptions: { globals: globals.node, ecmaVersion: 2025, sourceType: "module" },
    rules: {
      // Enforces AGENTS.md, Style.
      "max-params": ["error", { max: 3 }],
      "no-nested-ternary": "error",
      "func-style": ["error", "expression"],
      "prefer-arrow-callback": "error",
      "id-length": ["error", { min: 2, exceptions: ["_"], properties: "never" }],
      "no-restricted-syntax": ["error", ...RESTRICTED_SYNTAX],
      "no-restricted-properties": ["error", ...PROCESS_ENTRY_ONLY],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      // Off: `type` and `interface` are both allowed.
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Enforces AGENTS.md, Node: every promise is handled, and an async function is never passed
    // where the caller ignores its result. Both need type information, so only TypeScript files.
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["vitest.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: true }],
      // `void` is allowed only on a promise that cannot reject, which the rule cannot tell apart.
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
    },
  },
  {
    files: ["packages/**/*.ts", "apps/**/*.ts", "fixtures/**/*.ts", "tools/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: { "no-restricted-syntax": ["error", ...SOURCE_RESTRICTED_SYNTAX] },
  },
  {
    files: SERVING_FILES,
    ignores: NOT_SERVING_FILES,
    rules: { "no-restricted-syntax": ["error", ...SOURCE_RESTRICTED_SYNTAX, NO_SYNC_IO] },
  },
  {
    // Workspace entry points. Each repeats its list above because a later no-restricted-syntax
    // entry replaces an earlier one.
    files: [
      "packages/*/src/index.ts",
      "apps/*/src/index.ts",
      "fixtures/*/src/index.ts",
      "tools/*/src/index.ts",
    ],
    rules: { "no-restricted-syntax": ["error", ...SOURCE_RESTRICTED_SYNTAX, NO_EXPORT_ALL] },
  },
  {
    // The serving entry points, which also keep NO_SYNC_IO.
    files: ["packages/*/src/index.ts", "apps/server/src/index.ts", "apps/text-client/src/index.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...SOURCE_RESTRICTED_SYNTAX, NO_SYNC_IO, NO_EXPORT_ALL],
    },
  },
  {
    files: ["tests/*/src/index.ts"],
    rules: { "no-restricted-syntax": ["error", ...RESTRICTED_SYNTAX, NO_EXPORT_ALL] },
  },
  {
    // Keeps entry points small; the rule is in AGENTS.md, Node.
    files: ["**/main.ts"],
    rules: { "max-lines": ["error", 60] },
  },
  { files: PROCESS_ENTRY_FILES, rules: { "no-restricted-properties": "off" } },
  ...layerOverrides,
  // After the layer overrides, which it replaces for the kernel's source.
  KERNEL_NO_DEPENDENCIES,
);
