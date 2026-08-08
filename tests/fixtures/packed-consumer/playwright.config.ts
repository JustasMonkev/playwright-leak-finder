import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  projects: [
    { name: "setup", testMatch: "**/boot.setup.ts" },
    {
      name: "dependent",
      testMatch: "**/dependent.spec.ts",
      dependencies: ["setup"],
    },
    { name: "failing-setup", testMatch: "**/failing.setup.ts" },
    {
      name: "blocked",
      testMatch: "**/blocked.spec.ts",
      dependencies: ["failing-setup"],
    },
    {
      name: "teardown-setup",
      testMatch: "**/teardown.setup.ts",
      teardown: "teardown-cleanup",
    },
    {
      name: "teardown-cleanup",
      testMatch: "**/teardown.cleanup.ts",
    },
    {
      name: "teardown-dependent",
      testMatch: "**/teardown-dependent.spec.ts",
      dependencies: ["teardown-setup"],
    },
    {
      name: "teardown-skipped",
      testMatch: "**/teardown-skipped.spec.ts",
      dependencies: ["teardown-setup"],
    },
    { name: "isolated", testMatch: "**/isolated.spec.ts" },
  ],
});
