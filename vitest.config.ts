import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "tests/helpers/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false, // integration tests share one test database
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://resolvepay:resolvepay@localhost:5432/resolvepay_test",
    },
  },
});
