import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProject, repoRoot, runCli } from "./e2e-helpers";

const stateDir = (dir: string): string => path.join(dir, ".playwright-leak-finder");
const stateFile = (dir: string): string => path.join(stateDir(dir), "state.json");
const BANNER = `${"=".repeat(25)} Leak finder ${"=".repeat(25)}`;

const CONFIG = 'export default { testDir: "." };';

const MULTI_PROJECT_CONFIG = `export default {
  testDir: ".",
  projects: [{ name: "alpha" }, { name: "beta" }],
};`;

const ALL_PASS_SPEC = `import { test } from "@playwright/test";
test("one", () => {});
test("two", () => {});`;

const BROKEN_ALONE_SPEC = `import { expect, test } from "@playwright/test";
test("fine", () => {});
test("broken", () => { expect(1).toBe(2); });`;

// End-to-end coverage for the built CLI, spawned against throwaway
// Playwright projects under tests/ so @playwright/test resolves from the
// repo's node_modules. Specs are pure node assertions: no browser fixtures.
describe("CLI end-to-end", () => {
  async function leakyFixture(): Promise<string> {
    const dir = await createProject();
    await cp(path.join(repoRoot, "tests", "fixtures", "leaky-suite"), dir, { recursive: true });
    return dir;
  }

  it("finds the leak in one --auto run", { timeout: 180_000 }, async () => {
    const dir = await leakyFixture();

    const result = await runCli(dir, "--auto", "--config", "playwright.config.ts");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(BANNER);
    expect(result.stdout).toContain("We found a leak!");
    expect(result.stdout).toContain("Leak found in: demo.spec.ts › test3");
    // The finished search keeps its state saved until --reset.
    expect(existsSync(stateFile(dir))).toBe(true);
  });

  it("finds a writer that changes state before skipping at runtime", { timeout: 120_000 }, async () => {
    const dir = await createProject({
      "playwright.config.ts": CONFIG,
      "skip.spec.ts": `import { expect, test } from "@playwright/test";
        let dirty = false;
        test("writer", () => { dirty = true; test.skip(); });
        test("target", () => { expect(dirty).toBe(false); });`,
    });
    const result = await runCli(dir, "--auto");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Leak found in: skip.spec.ts › writer");
  });

  it("does not blame a prerequisite when the target skips in isolation", { timeout: 120_000 }, async () => {
    const dir = await createProject({
      "playwright.config.ts": CONFIG,
      "prerequisite.spec.ts": `import { expect, test } from "@playwright/test";
        let ready = false;
        test("prerequisite", () => { ready = true; });
        test("target", () => { test.skip(!ready); expect(1).toBe(2); });`,
    });

    const result = await runCli(dir, "--auto");

    expect(result.code).toBe(2);
    expect(result.stdout).toContain("inconclusive");
    expect(result.stdout).not.toContain("Leak found in:");
    expect(existsSync(stateFile(dir))).toBe(false);
  });

  it("stops when the target passes one isolated repeat and skips another", { timeout: 120_000 }, async () => {
    const dir = await createProject({
      "playwright.config.ts": 'export default { testDir: ".", repeatEach: 2 };',
      "repeat.spec.ts": `import { expect, test } from "@playwright/test";
        let ready = false;
        test("prerequisite", () => { ready = true; });
        test("target", ({}, info) => {
          if (info.repeatEachIndex === 0) return;
          test.skip(!ready);
          expect(1).toBe(2);
        });`,
    });

    const result = await runCli(dir, "--auto");

    expect(result.code).toBe(2);
    expect(result.stdout).toContain("inconclusive");
    expect(result.stdout).not.toContain("Leak found in:");
    expect(existsSync(stateFile(dir))).toBe(false);
  });

  it("advances one step per invocation and persists state between runs", { timeout: 180_000 }, async () => {
    const dir = await leakyFixture();

    const first = await runCli(dir);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("Target set to: demo.spec.ts › test5");
    expect(first.stdout).toContain("Suspects remaining: 4");
    expect(existsSync(stateFile(dir))).toBe(true);

    const second = await runCli(dir);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(
      "We reached the target and nothing failed. Let's bisect the other half.",
    );
    expect(second.stdout).toContain("Suspects remaining: 2");
    expect(existsSync(stateFile(dir))).toBe(true);

    const third = await runCli(dir);
    expect(third.code).toBe(0);
    expect(third.stdout).toContain("We found a leak!");
    expect(third.stdout).toContain("Leak found in: demo.spec.ts › test3");
  });

  it("exits 2 when every test passes", { timeout: 120_000 }, async () => {
    const dir = await createProject({
      "playwright.config.ts": CONFIG,
      "ok.spec.ts": ALL_PASS_SPEC,
    });

    const result = await runCli(dir);

    expect(result.code).toBe(2);
    expect(result.stdout).toContain("No test failed: there is no target to bisect.");
    expect(existsSync(stateDir(dir))).toBe(false);
  });

  it("exits 2 when the target fails on its own", { timeout: 120_000 }, async () => {
    const dir = await createProject({
      "playwright.config.ts": CONFIG,
      "broken.spec.ts": BROKEN_ALONE_SPEC,
    });

    const result = await runCli(dir);

    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "broken.spec.ts › broken has an unexpected outcome on its own; no earlier test is needed to reproduce it.",
    );
    expect(existsSync(stateDir(dir))).toBe(false);
  });

  it("exits 2 when nothing is collected", { timeout: 120_000 }, async () => {
    const dir = await createProject({
      "playwright.config.ts": 'export default { testDir: "./empty" };',
    });
    await mkdir(path.join(dir, "empty"));

    const result = await runCli(dir);

    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "No tests were collected, so there is nothing to bisect.",
    );
    expect(existsSync(stateDir(dir))).toBe(false);
  });

  it("does not blame one generated test when its location also selects another", { timeout: 120_000 }, async () => {
    const dir = await createProject({
      "playwright.config.ts": CONFIG,
      "generated.spec.ts": [
        'import { expect, test } from "@playwright/test";',
        "let leaked = false;",
        'for (const name of ["innocent", "leaker"]) {',
        '  test(name, () => { if (name === "leaker") leaked = true; });',
        "}",
        'test("target", () => expect(leaked).toBe(false));',
      ].join("\n"),
    });

    const result = await runCli(dir, "--auto");

    expect(result.code).toBe(2);
    expect(result.stdout).toContain("Target set to: generated.spec.ts › target");
    expect(result.stdout).toContain("The tests that ran are not the ones selected, so this step is inconclusive.");
    expect(result.stdout).not.toContain("Leak found in:");
  });

  it("exits 1 and leaves no state on a reserved flag", { timeout: 30_000 }, async () => {
    const dir = await createProject({
      "playwright.config.ts": CONFIG,
      "ok.spec.ts": ALL_PASS_SPEC,
    });

    const result = await runCli(dir, "--workers=2");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Cannot forward --workers=2");
    expect(existsSync(stateDir(dir))).toBe(false);
  });

  it("exits 1 and leaves no state on a bare test filter", { timeout: 30_000 }, async () => {
    const dir = await createProject({
      "playwright.config.ts": CONFIG,
      "ok.spec.ts": ALL_PASS_SPEC,
    });

    const result = await runCli(dir, "ok.spec.ts");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Cannot forward the test filter "ok.spec.ts"');
    expect(existsSync(stateDir(dir))).toBe(false);
  });

  it("exits 1 and leaves no state on a multi-project run without --project", { timeout: 120_000 }, async () => {
    const dir = await createProject({
      "multi.config.ts": MULTI_PROJECT_CONFIG,
      "ok.spec.ts": ALL_PASS_SPEC,
    });

    const result = await runCli(dir, "--config", "multi.config.ts");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("This run covers 2 Playwright projects");
    expect(result.stderr).toContain("--project=<name>");
    expect(existsSync(stateDir(dir))).toBe(false);
  });

  it("--help exits 0 and prints usage", { timeout: 30_000 }, async () => {
    const dir = await leakyFixture();

    const result = await runCli(dir, "--help");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--auto");
  });

  it("--status reports no search, then the active target", { timeout: 180_000 }, async () => {
    const dir = await leakyFixture();

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
    const dir = await leakyFixture();

    const first = await runCli(dir);
    expect(first.code).toBe(0);
    expect(existsSync(stateFile(dir))).toBe(true);

    const reset = await runCli(dir, "--reset");
    expect(reset.code).toBe(0);
    expect(reset.stdout).toContain("Leak finder state cleared.");
    expect(existsSync(stateFile(dir))).toBe(false);

    const restart = await runCli(dir);
    expect(restart.code).toBe(0);
    expect(restart.stdout).toContain("Target set to: demo.spec.ts › test5");
  });
});
