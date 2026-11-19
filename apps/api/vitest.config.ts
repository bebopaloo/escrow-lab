import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A new test database for each run (test/global-setup.ts).
    globalSetup: ["./test/global-setup.ts"],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Integration tests share one database.
    fileParallelism: false,
  },
});
