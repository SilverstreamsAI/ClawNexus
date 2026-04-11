import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    testTimeout: 10_000,
    restoreMocks: true,
    coverage: {
      thresholds: {
        statements: 90,
        branches: 82,
        functions: 88,
        lines: 91,
      },
    },
  },
});
