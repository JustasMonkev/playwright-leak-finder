import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3210);

export default defineConfig({
  testDir: "./tests",
  reporter: "list",
  // One worker, in file order: the leak only reproduces when the tests run in
  // a single, deterministic order — which is also what the leak finder forces.
  fullyParallel: false,
  workers: 1,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node server.mjs",
    url: `http://localhost:${PORT}`,
    // Never reuse a server: leftover tasks must come from the tests in this
    // run, not from the previous one.
    reuseExistingServer: false,
    stdout: "ignore",
  },
});
