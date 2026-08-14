import os from "node:os";
import path from "node:path";
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
    "--last-failed",
    "--last-failed-file=.last-run.json",
    "--ui",
    "--ui-host=127.0.0.1",
    "--ui-port=9323",
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
  ])("accepts %s, which can only narrow the run", async (...args) => {
    // Resolution of @playwright/test is what fails next, not the arg check.
    // Assert that exact message: `rejects.not.toThrow` alone would also pass
    // if validation started rejecting these with some other wording.
    await expect(runner.run({ passthroughArgs: args })).rejects.toThrow(
      /Could not resolve @playwright\/test/,
    );
    await expect(runner.list(args)).rejects.toThrow(
      /Could not resolve @playwright\/test/,
    );
  });

  it("rejects a positional filter from list() too, not just run()", async () => {
    await expect(runner.list(["demo.spec.ts"])).rejects.toThrow(
      /widening every step/,
    );
  });

  it("names the project directory when @playwright/test cannot be resolved", async () => {
    // The one error a consumer hits before anything else works, so it has to
    // say where the finder looked and what to do about it.
    await expect(runner.list([])).rejects.toThrow(
      new RegExp(
        `Could not resolve @playwright/test from ${escapeRegex(path.resolve(os.tmpdir()))}\\. ` +
          "Install it in your project before running the leak finder\\.",
        "u",
      ),
    );
  });

  it("validates arguments before spawning anything", async () => {
    // Validation must not depend on Playwright being installed: a reserved
    // flag has to be reported as such even in a project without it.
    await expect(runner.run({ passthroughArgs: ["--workers=4"] })).rejects.toThrow(
      /leak finder controls/,
    );
  });
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
