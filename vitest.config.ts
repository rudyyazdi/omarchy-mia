import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "packages/*/src/**/*.test.ts",
            "apps/*/src/**/*.test.ts",
            "fixtures/*/src/**/*.test.ts",
          ],
          testTimeout: 5_000,
          hookTimeout: 5_000,
        },
      },
      {
        extends: true,
        test: {
          name: "acceptance",
          include: ["tests/*/src/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
