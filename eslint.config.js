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
  // Layer 4: tests are the top entry point and forbid nothing, so they get no override.
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
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  prettier,
  {
    files: ["**/*.ts", "**/*.js", "**/*.mjs"],
    languageOptions: { globals: globals.node, ecmaVersion: 2025, sourceType: "module" },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // Repo style rules; each has a rationale in AGENTS.md.
      "max-params": ["error", { max: 3 }],
      "no-nested-ternary": "error",
      "func-style": ["error", "expression"],
      "prefer-arrow-callback": "error",
      "id-length": ["error", { min: 2, exceptions: ["_"], properties: "never" }],
      "no-restricted-syntax": [
        "error",
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
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  ...layerOverrides,
);
