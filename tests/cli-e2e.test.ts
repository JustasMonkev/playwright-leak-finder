import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const CLI = path.join(repoRoot, "dist", "cli.mjs");
const stateDir = (dir: string): string => path.join(dir, ".playwright-leak-finder");
const stateFile = (dir: string): string => path.join(stateDir(dir), "state.json");
const BANNER = `${"=".repeat(25)} Leak finder ${"=".repeat(25)}`;

const CONFIG =
  'import { defineConfig } from "@playwright/test";\n' +
  'export default defineConfig({ testDir: "." });\n';

const MULTI_PROJECT_CONFIG =
  'import { defineConfig } from "@playwright/test";\n' +
  "export default defineConfig({\n" +
  '  testDir: ".",\n' +
  '  projects: [{ name: "alpha" }, { name: "beta" }],\n' +
  "});\n";

const ALL_PASS_SPEC =
  'import { expect, test } from "@playwright/test";\n' +
  "\n" +
  'test("one", () => {\n' +
  "  expect(true).toBe(true);\n" +
  "});\n" +
  "\n" +
  'test("two", () => {\n' +
  "  expect(true).toBe(true);\n" +
  "});\n";

const BROKEN_ALONE_SPEC =
  'import { expect, test } from "@playwright/test";\n' +
  "\n" +
  'test("fine", () => {});\n' +
  "\n" +
  'test("broken", () => {\n' +
  "  expect(1).toBe(2);\n" +
  "});\n";

// The victim only fails when BOTH earlier tests ran, so no single test
// reproduces it and bisection cannot converge.
const PAIR_LEAK_SPEC =
  'import { expect, test } from "@playwright/test";\n' +
  "\n" +
  "const state: string[] = [];\n" +
  "\n" +
  'test("leakA", () => {\n' +
  '  state.push("a");\n' +
  "});\n" +
  "\n" +
  'test("leakB", () => {\n' +
  '  state.push("b");\n' +
  "});\n" +
  "\n" +
  'test("victim", () => {\n' +
  '  expect(state.includes("a") && state.includes("b")).toBe(false);\n' +
  "});\n";

// End-to-end coverage for the built CLI, spawned against throwaway
// Playwright projects under tests/ so @playwright/test resolves from the
// repo's node_modules. Specs are pure node assertions: no browser fixtures.
describe("CLI end-to-end", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });

  function runCli(
    cwd: string,
    ...args: string[]
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  async function track(dir: string): Promise<string> {
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  async function demoFixture(): Promise<string> {
    const dir = await track(await mkdtemp(path.join(repoRoot, "tests", ".tmp-cli-")));
    await cp(path.join(repoRoot, "demo"), dir, { recursive: true });
    return dir;
  }

  async function fileFixture(files: Record<string, string>): Promise<string> {
    const dir = await track(await mkdtemp(path.join(repoRoot, "tests", ".tmp-cli-")));
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dir, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    return dir;
  }

  const exists = (file: string): Promise<boolean> =>
    access(file).then(
      () => true,
      () => false,
    );

  it("finds the demo leak in one --auto run", { timeout: 180_000 }, async () => {
    const dir = await demoFixture();

    const result = await runCli(dir, "--auto", "--config", "playwright.config.ts");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(BANNER);
    expect(result.stdout).toContain("We found a leak!");
    expect(result.stdout).toContain("Leak found in: demo.spec.ts › test3");
    // The finished search keeps its state saved until --reset.
    expect(await exists(stateFile(dir))).toBe(true);
  });

  it("advances one step per invocation and persists state between runs", { timeout: 180_000 }, async () => {
    const dir = await demoFixture();

    const first = await runCli(dir);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("Target set to: demo.spec.ts › test5");
    expect(first.stdout).toContain("Suspects remaining: 4");
    expect(await exists(stateFile(dir))).toBe(true);

    const second = await runCli(dir);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(
      "We reached the target and nothing failed. Let's bisect the other half.",
    );
    expect(second.stdout).toContain("Suspects remaining: 2");
    expect(await exists(stateFile(dir))).toBe(true);

    const third = await runCli(dir);
    expect(third.code).toBe(0);
    expect(third.stdout).toContain("We found a leak!");
    expect(third.stdout).toContain("Leak found in: demo.spec.ts › test3");
  });

  it("exits 2 when every test passes", { timeout: 120_000 }, async () => {
    const dir = await fileFixture({
      "playwright.config.ts": CONFIG,
      "ok.spec.ts": ALL_PASS_SPEC,
    });

    const result = await runCli(dir);

    expect(result.code).toBe(2);
    expect(result.stdout).toContain("No test failed: there is no target to bisect.");
    expect(await exists(stateDir(dir))).toBe(false);
  });

  it("exits 2 when the target fails on its own", { timeout: 120_000 }, async () => {
    const dir = await fileFixture({
      "playwright.config.ts": CONFIG,
      "broken.spec.ts": BROKEN_ALONE_SPEC,
    });

    const result = await runCli(dir);

    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "broken.spec.ts › broken fails on its own, so no earlier test is leaking into it.",
    );
    expect(await exists(stateDir(dir))).toBe(false);
  });

  it("exits 2 when nothing is collected", { timeout: 120_000 }, async () => {
    const dir = await fileFixture({
      "playwright.config.ts":
        'import { defineConfig } from "@playwright/test";\n' +
        'export default defineConfig({ testDir: "./empty" });\n',
    });
    await mkdir(path.join(dir, "empty"));

    const result = await runCli(dir);

    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "No tests were collected, so there is nothing to bisect.",
    );
    expect(await exists(stateDir(dir))).toBe(false);
  });

  it("exits 2 when the leak needs two tests together", { timeout: 180_000 }, async () => {
    const dir = await fileFixture({
      "playwright.config.ts": CONFIG,
      "pair.spec.ts": PAIR_LEAK_SPEC,
    });

    const result = await runCli(dir, "--auto");

    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "The search cannot narrow any further: no single earlier test makes the target fail.",
    );
    // The search did run, so its state stays saved until --reset.
    expect(await exists(stateFile(dir))).toBe(true);
  });

  it("exits 1 and leaves no state on a reserved flag", { timeout: 30_000 }, async () => {
    const dir = await fileFixture({
      "playwright.config.ts": CONFIG,
      "ok.spec.ts": ALL_PASS_SPEC,
    });

    const result = await runCli(dir, "--workers=2");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Cannot forward --workers=2");
    expect(await exists(stateDir(dir))).toBe(false);
  });

  it("exits 1 and leaves no state on a bare test filter", { timeout: 30_000 }, async () => {
    const dir = await fileFixture({
      "playwright.config.ts": CONFIG,
      "ok.spec.ts": ALL_PASS_SPEC,
    });

    const result = await runCli(dir, "ok.spec.ts");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Cannot forward the test filter "ok.spec.ts"');
    expect(await exists(stateDir(dir))).toBe(false);
  });

  it("exits 1 and leaves no state on a multi-project run without --project", { timeout: 120_000 }, async () => {
    const dir = await fileFixture({
      "multi.config.ts": MULTI_PROJECT_CONFIG,
      "ok.spec.ts": ALL_PASS_SPEC,
    });

    const result = await runCli(dir, "--config", "multi.config.ts");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("This run covers 2 Playwright projects");
    expect(result.stderr).toContain("--project=<name>");
    expect(await exists(stateDir(dir))).toBe(false);
  });

  it("--help exits 0 and prints usage", { timeout: 30_000 }, async () => {
    const dir = await demoFixture();

    const result = await runCli(dir, "--help");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--auto");
  });

  it("--status reports no search, then the active target", { timeout: 180_000 }, async () => {
    const dir = await demoFixture();

    const empty = await runCli(dir, "--status");
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("No active search.");

    const first = await runCli(dir);
    expect(first.code).toBe(0);

    const active = await runCli(dir, "--status");
    expect(active.code).toBe(0);
    expect(active.stdout).toContain("Current target is: demo.spec.ts › test5");
    expect(active.stdout).toContain("Next step: a");
  });

  it("--reset clears the state so the next run starts over", { timeout: 180_000 }, async () => {
    const dir = await demoFixture();

    const first = await runCli(dir);
    expect(first.code).toBe(0);
    expect(await exists(stateFile(dir))).toBe(true);

    const reset = await runCli(dir, "--reset");
    expect(reset.code).toBe(0);
    expect(reset.stdout).toContain("Leak finder state cleared.");
    expect(await exists(stateFile(dir))).toBe(false);

    const restart = await runCli(dir);
    expect(restart.code).toBe(0);
    expect(restart.stdout).toContain("Target set to: demo.spec.ts › test5");
  });
});
