import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.e2e.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Golden paths hit one composed stack — run files serially.
    fileParallelism: false
  }
});
