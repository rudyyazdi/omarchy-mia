import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "fixtures/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "tests/*/src/**/*.test.ts",
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
