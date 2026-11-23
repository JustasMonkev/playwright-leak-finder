import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProject, runCli } from "./e2e-helpers";

const CONFIG =
  'import { defineConfig } from "@playwright/test";\n' +
  'export default defineConfig({ testDir: "../specs" });\n';

const LEAKY_SPEC =
  'import { expect, test } from "@playwright/test";\n' +
  "const state: string[] = [];\n" +
  'test("setup", () => {});\n' +
  'test("leaker", () => { state.push("leak"); });\n' +
  'test("victim", () => { expect(state).toEqual([]); });\n';

const PASSING_SPEC =
  'import { expect, test } from "@playwright/test";\n' +
  'test("works", () => { expect(true).toBe(true); });\n';

describe("CLI real-user scenarios", () => {
  it.each([
    "--fail-on-flaky-tests",
    "--forbid-only",
    "--fully-parallel",
    "--headed",
    "--ignore-snapshots",
    "--no-deps",
    "--pass-with-no-tests",
    "--quiet",
  ])("rejects a bare test filter following boolean Playwright flag %s", { timeout: 30_000 }, async (flag) => {
    const root = await createProject({
      "playwright.config.ts":
        'import { defineConfig } from "@playwright/test";\n' +
        'export default defineConfig({ testDir: "." });\n',
      "leaky.spec.ts": LEAKY_SPEC,
    });

    const result = await runCli(root, flag, "leaky.spec.ts");

    // The documented contract rejects positional filters because they widen
    // the file:line selections used during bisection. Boolean flags cannot
    // make the following positional argument look like a value.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Cannot forward the test filter "leaky.spec.ts"');
    expect(existsSync(path.join(root, ".playwright-leak-finder"))).toBe(false);
  });

  it("works from a nested directory with a separately passed config path containing spaces", { timeout: 120_000 }, async () => {
    const root = await createProject({
      "configs/playwright config.ts": CONFIG,
      "specs/ok.spec.ts": PASSING_SPEC,
    });
    const nestedCwd = path.join(root, "work", "deeply", "nested");
    await mkdir(nestedCwd, { recursive: true });

    const result = await runCli(
      nestedCwd,
      "--config",
      "../../../configs/playwright config.ts",
    );

    expect(result.code).toBe(2);
    expect(result.stdout).toContain("No test failed: there is no target to bisect.");
    expect(result.stderr).toBe("");
    expect(existsSync(path.join(nestedCwd, ".playwright-leak-finder"))).toBe(false);
  });

  it("accepts an equals-form config path with spaces and completes automatic bisection", { timeout: 180_000 }, async () => {
    const root = await createProject({
      "config directory/playwright config.ts": CONFIG,
      "specs/leaky.spec.ts": LEAKY_SPEC,
    });

    const result = await runCli(
      root,
      "--auto",
      "--config=config directory/playwright config.ts",
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("We found a leak!");
    expect(result.stdout).toContain("Leak found in: leaky.spec.ts › leaker");
    expect(result.stderr).toBe("");
  });

  it("reports an unknown Playwright option on stderr and does not create state", { timeout: 30_000 }, async () => {
    const root = await createProject({
      "playwright.config.ts":
        'import { defineConfig } from "@playwright/test";\n' +
        'export default defineConfig({ testDir: "." });\n',
      "ok.spec.ts": PASSING_SPEC,
    });

    const result = await runCli(root, "--not-a-real-playwright-option");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Playwright exited with code 1 without producing a JSON report");
    expect(existsSync(path.join(root, ".playwright-leak-finder"))).toBe(false);
  });

  it.each([
    ["--workers", "2"],
    ["--reporter", "json"],
    ["--max-failures", "1"],
    ["-j", "2"],
    ["--last-failed"],
    ["--last-failed-file", ".last-run.json"],
    ["--ui-host", "127.0.0.1"],
    ["--ui-port", "9323"],
  ])("rejects protected Playwright argument %s when its value is separate", { timeout: 30_000 }, async (...args: string[]) => {
    const root = await createProject({
      "playwright.config.ts":
        'import { defineConfig } from "@playwright/test";\n' +
        'export default defineConfig({ testDir: "." });\n',
      "ok.spec.ts": PASSING_SPEC,
    });

    const result = await runCli(root, ...args);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Cannot forward ${args[0]}`);
    expect(existsSync(path.join(root, ".playwright-leak-finder"))).toBe(false);
  });
});
