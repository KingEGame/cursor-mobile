import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      // Tests stay in-memory unless a suite opts into a temp HUB_DATA_DIR.
      HUB_DATA_DIR: "none",
    },
    include: [
      "src/**/*.test.ts",
      "test/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
  },
});
