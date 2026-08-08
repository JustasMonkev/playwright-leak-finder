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
    { name: "isolated", testMatch: "**/isolated.spec.ts" },
  ],
});
