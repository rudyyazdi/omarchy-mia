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
  { files: ["packages/protocol/**"], workspaces: ["@mia/protocol"], mayImportAnything: false },
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

const RESTRICTED_SYNTAX = [
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
];

// Source files outside tests: everything above, plus the rules that only apply to shipped code.
const SOURCE_RESTRICTED_SYNTAX = [
  ...RESTRICTED_SYNTAX,
  {
    selector: 'NewExpression[callee.name="Promise"]',
    message: `Use Promise.withResolvers, AbortSignal.timeout or once(). ${BYPASS_NOTE}`,
  },
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
    files: ["tests/*/src/index.ts"],
    rules: { "no-restricted-syntax": ["error", ...RESTRICTED_SYNTAX, NO_EXPORT_ALL] },
  },
  {
    // Keeps entry points small; the rule is in AGENTS.md, Node.
    files: ["**/main.ts"],
    rules: { "max-lines": ["error", 60] },
  },
  ...layerOverrides,
);
