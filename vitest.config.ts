import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Let tests import the package by name, like a real consumer would.
    alias: {
      "playwright-leak-finder": fileURLToPath(
        new URL("src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
