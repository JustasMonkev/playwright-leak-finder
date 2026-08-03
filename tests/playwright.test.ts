import os from "node:os";
import { describe, expect, it } from "vitest";
import { PlaywrightRunner } from "playwright-leak-finder";

// A cwd with no @playwright/test to resolve: rejected arguments throw before
// anything spawns, and accepted ones get as far as resolving the CLI.
const runner = new PlaywrightRunner({ cwd: os.tmpdir() });

describe("forwarded argument validation", () => {
  it.each([
    "--workers=2",
    "--workers",
    "-j",
    "-j2",
    "-xj2",
    "--reporter=list",
    "--reporter",
    "--max-failures=3",
    "-x",
    "--list",
    "--retries=1",
    "--shard=1/2",
    "--repeat-each=3",
    "--ui",
    "--debug",
  ])("rejects %s, which would override what the search controls", async (arg) => {
    await expect(runner.run({ passthroughArgs: [arg] })).rejects.toThrow(
      /leak finder controls/,
    );
    await expect(runner.list([arg])).rejects.toThrow(/leak finder controls/);
  });

  it("rejects a positional filter, which would widen each step", async () => {
    await expect(runner.run({ passthroughArgs: ["demo.spec.ts"] })).rejects.toThrow(
      /widening every step/,
    );
  });

  it.each([
    ["--config", "demo"],
    ["--grep", "test3"],
    ["--project", "chromium"],
    ["--headed"],
  ])("accepts %s, which can only narrow the run", (...args) => {
    // Resolution of @playwright/test is what fails next, not the arg check.
    return expect(runner.run({ passthroughArgs: args })).rejects.not.toThrow(
      /leak finder controls|widening every step/,
    );
  });
});
