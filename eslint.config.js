import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

const BYPASS_NOTE = "Bypass with an eslint-disable-next-line comment that carries a `-- reason`.";

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
);
