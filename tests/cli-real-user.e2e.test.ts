import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const cli = path.join(repoRoot, "dist", "cli.mjs");

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

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe("CLI real-user scenarios", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterAll(async () => {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
  });

  async function fixture(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(repoRoot, "tests", ".tmp-real-user-cli-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    for (const [name, contents] of Object.entries(files)) {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
    return root;
  }

  function run(cwd: string, ...args: string[]): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      // Vitest sets both variables, which makes each Playwright child emit a
      // Node warning to stderr unrelated to the CLI contract under test.
      const env = { ...process.env };
      delete env.FORCE_COLOR;
      delete env.NO_COLOR;
      const child = spawn(process.execPath, [cli, ...args], { cwd, env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  const exists = async (file: string): Promise<boolean> =>
    access(file).then(
      () => true,
      () => false,
    );

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
    const root = await fixture({
      "playwright.config.ts":
        'import { defineConfig } from "@playwright/test";\n' +
        'export default defineConfig({ testDir: "." });\n',
      "leaky.spec.ts": LEAKY_SPEC,
    });

    const result = await run(root, flag, "leaky.spec.ts");

    // The documented contract rejects positional filters because they widen
    // the file:line selections used during bisection. Boolean flags cannot
    // make the following positional argument look like a value.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Cannot forward the test filter "leaky.spec.ts"');
    expect(await exists(path.join(root, ".playwright-leak-finder"))).toBe(false);
  });

  it("works from a nested directory with a separately passed config path containing spaces", { timeout: 120_000 }, async () => {
    const root = await fixture({
      "configs/playwright config.ts": CONFIG,
      "specs/ok.spec.ts": PASSING_SPEC,
    });
    const nestedCwd = path.join(root, "work", "deeply", "nested");
    await mkdir(nestedCwd, { recursive: true });

    const result = await run(
      nestedCwd,
      "--config",
      "../../../configs/playwright config.ts",
    );

    expect(result.code).toBe(2);
    expect(result.stdout).toContain("No test failed: there is no target to bisect.");
    expect(result.stderr).toBe("");
    expect(await exists(path.join(nestedCwd, ".playwright-leak-finder"))).toBe(false);
  });

  it("accepts an equals-form config path with spaces and completes automatic bisection", { timeout: 180_000 }, async () => {
    const root = await fixture({
      "config directory/playwright config.ts": CONFIG,
      "specs/leaky.spec.ts": LEAKY_SPEC,
    });

    const result = await run(
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
    const root = await fixture({
      "playwright.config.ts":
        'import { defineConfig } from "@playwright/test";\n' +
        'export default defineConfig({ testDir: "." });\n',
      "ok.spec.ts": PASSING_SPEC,
    });

    const result = await run(root, "--not-a-real-playwright-option");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Playwright exited with code 1 without producing a JSON report");
    expect(await exists(path.join(root, ".playwright-leak-finder"))).toBe(false);
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
    const root = await fixture({
      "playwright.config.ts":
        'import { defineConfig } from "@playwright/test";\n' +
        'export default defineConfig({ testDir: "." });\n',
      "ok.spec.ts": PASSING_SPEC,
    });

    const result = await run(root, ...args);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Cannot forward ${args[0]}`);
    expect(await exists(path.join(root, ".playwright-leak-finder"))).toBe(false);
  });
});
