import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { command, createProject, repoRoot, runCli } from "./e2e-helpers";

const fixtureRoot = path.join(repoRoot, "tests", "fixtures", "state-workflows");

const stateDirectory = (cwd: string): string =>
  path.join(cwd, ".playwright-leak-finder");
const stateFile = (cwd: string): string => path.join(stateDirectory(cwd), "state.json");
const targetId = "scenario.spec.ts › target";
const writerId = "scenario.spec.ts › writer";
const singleLeakSnapshot = {
  playwrightArgs: [],
  isolationVerified: true,
  allIsolatedRepeatsVerified: true,
  steps: "a",
  target: targetId,
  items: [
    { id: writerId, file: "scenario.spec.ts", line: 5 },
    { id: targetId, file: "scenario.spec.ts", line: 9 },
  ],
};

/**
 * These use copied real Playwright projects and the packaged CLI, rather than
 * a fake runner, because state is meaningful only across separate processes.
 */
describe("persisted state through real user workflows", () => {
  async function project(spec: string): Promise<string> {
    const directory = await createProject();
    await cp(path.join(fixtureRoot, "playwright.config.ts"), path.join(directory, "playwright.config.ts"));
    await cp(path.join(fixtureRoot, spec), path.join(directory, "scenario.spec.ts"));
    return directory;
  }

  async function savedState(cwd: string): Promise<unknown> {
    return JSON.parse(await readFile(stateFile(cwd), "utf8"));
  }

  it("does not reuse project A's isolation result in project B", { timeout: 120_000 }, async () => {
    const cwd = await createProject({
      "playwright.config.cjs": "module.exports = { projects: [{ name: 'A' }, { name: 'B' }], outputDir: __dirname + '/test-results' };",
      "scenario.spec.cjs": [
        "const { test, expect } = require('@playwright/test');",
        "let dirty = false;",
        "test('writer', () => { dirty = true; });",
        "test('target', ({}, info) => { expect(dirty || info.project.name === 'B').toBe(false); });",
      ].join("\n"),
    });

    expect((await runCli(cwd, "--project=A")).code).toBe(0);
    const before = await readFile(stateFile(cwd), "utf8");
    const invalid = await runCli(cwd, "--project=A", "--workers=2");
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("Cannot forward --workers=2");
    expect(await readFile(stateFile(cwd), "utf8")).toBe(before);

    const changed = await runCli(cwd, "--project=B", "--auto");
    expect(changed.stdout).not.toContain("Leak found in:");
    expect(changed.code).toBe(2);
    expect(changed.stdout).toContain("forwarded Playwright arguments differ");
    expect(await readFile(stateFile(cwd), "utf8")).toBe(before);
    expect((await runCli(cwd, "--project=A")).stdout).toContain("Leak found in: scenario.spec.cjs › writer");
    await runCli(cwd, "--reset");
    const independent = await runCli(cwd, "--project=B");
    expect(independent.code).toBe(2);
    expect(independent.stdout).toContain("unexpected outcome on its own");
  });

  it.each([{}, { isolationVerified: true }])("rechecks legacy isolation without argument context: %j", { timeout: 120_000 }, async (legacy) => {
    const cwd = await project("single-leak.spec.ts");
    const spec = path.join(cwd, "scenario.spec.ts");
    const original = await readFile(spec, "utf8");
    await writeFile(spec, original.replace("expect(shared)", "test.skip(shared.length === 0); expect(shared)"));
    const oldState = JSON.stringify({ ...legacy, steps: "a", target: targetId, items: singleLeakSnapshot.items });
    await mkdir(stateDirectory(cwd));
    await writeFile(stateFile(cwd), oldState);

    const replay = await runCli(cwd, "--auto");

    expect(replay.code).toBe(2);
    expect(replay.stdout).toContain("inconclusive");
    expect(replay.stdout).not.toContain("Leak found in:");
    expect(await readFile(stateFile(cwd), "utf8")).toBe(oldState);
  });

  it("does not discard project B's writer using a legacy partition from project A", { timeout: 120_000 }, async () => {
    const cwd = await createProject({
      "playwright.config.cjs": "module.exports = { projects: [{ name: 'A' }, { name: 'B' }] };",
      "scenario.spec.cjs": [
        "const { test, expect } = require('@playwright/test');",
        "let dirty = false;",
        "test('writer in B', ({}, info) => { dirty = info.project.name === 'B'; });",
        "test('innocent one', () => {});",
        "test('writer in A', ({}, info) => { if (info.project.name === 'A') dirty = true; });",
        "test('innocent two', () => {});",
        "test('target', () => { expect(dirty).toBe(false); });",
      ].join("\n"),
    });
    expect((await runCli(cwd, "--project=A")).code).toBe(0);
    expect((await runCli(cwd, "--project=A")).code).toBe(0);
    const legacy = JSON.parse(await readFile(stateFile(cwd), "utf8"));
    expect(legacy.steps).toBe("ba");
    delete legacy.playwrightArgs;
    await writeFile(stateFile(cwd), JSON.stringify(legacy));

    const result = await runCli(cwd, "--auto", "--project=B");
    expect(result.stdout).toContain("Leak found in: scenario.spec.cjs › writer in B");
    expect(result.code).toBe(0);
    expect(await savedState(cwd)).toMatchObject({ playwrightArgs: ["--project=B"] });
  });

  it("keeps status and reset truthful before, during, and after a search", { timeout: 120_000 }, async () => {
    const cwd = await project("single-leak.spec.ts");

    expect((await runCli(cwd, "--status")).stdout).toContain("No active search.");

    const started = await runCli(cwd);
    expect(started.code).toBe(0);
    expect(started.stdout).toContain("Suspects remaining: 1");
    expect(started.stdout).toContain(`Target set to: ${targetId}`);
    expect(existsSync(stateFile(cwd))).toBe(true);

    const inProgress = await runCli(cwd, "--status");
    expect(inProgress.code).toBe(0);
    expect(inProgress.stdout).toContain(`Current target is: ${targetId}`);
    expect(inProgress.stdout).toContain("Next step: a");

    const found = await runCli(cwd);
    expect(found.code).toBe(0);
    expect(found.stdout).toContain(`Leak found in: ${writerId}`);

    const completed = await runCli(cwd, "--status");
    expect(completed.stdout).toContain(`Current target is: ${targetId}`);

    const reset = await runCli(cwd, "--reset");
    expect(reset.code).toBe(0);
    expect(reset.stdout).toContain("Leak finder state cleared.");
    expect(existsSync(stateFile(cwd))).toBe(false);
    expect((await runCli(cwd, "--status")).stdout).toContain("No active search.");
  });

  it.each([
    ["truncated", '{"steps":"a"'],
    ["wrong top-level shape", '[]'],
    ["invalid target", '{"steps":"a","target":42,"items":[]}'],
    ["invalid item", '{"steps":"a","target":"target","items":[{"id":1}]}'],
    ["invalid bisection steps", '{"steps":"not-a-search-step","target":"scenario.spec.ts › target","items":[]}'],
    ["negative item line", '{"steps":"a","target":"scenario.spec.ts › target","items":[{"id":"scenario.spec.ts › target","file":"scenario.spec.ts","line":-1}]}'],
    ["fractional item line", '{"steps":"a","target":"scenario.spec.ts › target","items":[{"id":"scenario.spec.ts › target","file":"scenario.spec.ts","line":1.5}]}'],
    ["blank item id", '{"steps":"a","target":"","items":[{"id":"","file":"scenario.spec.ts","line":1}]}'],
    ["blank item file", '{"steps":"a","target":"scenario.spec.ts › target","items":[{"id":"scenario.spec.ts › target","file":"","line":1}]}'],
    ["target absent from the snapshot", '{"steps":"a","target":"scenario.spec.ts › target","items":[{"id":"scenario.spec.ts › writer","file":"scenario.spec.ts","line":5}]}'],
    ["empty steps with an active target", '{"steps":"","target":"scenario.spec.ts › target","items":[{"id":"scenario.spec.ts › target","file":"scenario.spec.ts","line":9}]}'],
  ])("starts fresh and replaces %s saved state", { timeout: 120_000 }, async (_name, invalid) => {
    const cwd = await project("single-leak.spec.ts");
    await mkdir(stateDirectory(cwd), { recursive: true });
    await writeFile(stateFile(cwd), invalid);

    const result = await runCli(cwd);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Target set to: ${targetId}`);
    expect(await savedState(cwd)).toEqual(singleLeakSnapshot);
  });

  it("keeps independent searches isolated by each project's cwd", { timeout: 120_000 }, async () => {
    const first = await project("single-leak.spec.ts");
    const second = await project("three-before-target.spec.ts");

    await runCli(first);
    await runCli(second);
    expect(await savedState(first)).toEqual(singleLeakSnapshot);
    expect(await savedState(second)).toMatchObject({
      target: targetId,
      items: [
        { id: "scenario.spec.ts › innocent one" },
        { id: writerId },
        { id: "scenario.spec.ts › innocent two" },
        { id: targetId },
      ],
    });

    await runCli(first, "--reset");
    expect(existsSync(stateFile(first))).toBe(false);
    expect(existsSync(stateFile(second))).toBe(true);
    expect((await runCli(second, "--status")).stdout).toContain("Next step: a");
  });

  it("does not overwrite active state when Playwright cannot start a later step", { timeout: 120_000 }, async () => {
    const cwd = await project("single-leak.spec.ts");
    expect((await runCli(cwd)).code).toBe(0);
    const before = await readFile(stateFile(cwd), "utf8");

    await writeFile(path.join(cwd, "playwright.config.ts"), "this is not valid TypeScript(");
    const interrupted = await runCli(cwd);

    expect(interrupted.code).toBe(1);
    expect(await readFile(stateFile(cwd), "utf8")).toBe(before);
    expect((await runCli(cwd, "--status")).stdout).toContain("Next step: a");
  });

  it("stops inconclusively when a saved file:line snapshot becomes stale", { timeout: 120_000 }, async () => {
    const cwd = await project("three-before-target.spec.ts");
    expect((await runCli(cwd)).code).toBe(0);

    const spec = path.join(cwd, "scenario.spec.ts");
    const original = await readFile(spec, "utf8");
    await writeFile(spec, `\n\n${original}`);

    const result = await runCli(cwd);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("The target did not run, so this step is inconclusive.");
    expect(result.stdout).toContain(`Current target is: ${targetId}`);
  });

  it("stops inconclusively when the snapshot's spec file is moved", { timeout: 120_000 }, async () => {
    const cwd = await project("three-before-target.spec.ts");
    expect((await runCli(cwd)).code).toBe(0);

    await rename(path.join(cwd, "scenario.spec.ts"), path.join(cwd, "renamed.spec.ts"));
    const result = await runCli(cwd);

    expect(result.code).toBe(2);
    expect(result.stdout).toContain("The target did not run, so this step is inconclusive.");
  });

  it("reports a combination-only leak as inconclusive instead of blaming either test", { timeout: 120_000 }, async () => {
    const cwd = await project("combo-only-leak.spec.ts");

    const result = await runCli(cwd, "--auto");
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "The search cannot narrow any further: no single earlier test makes the target fail.",
    );
    expect(result.stdout).not.toContain("Leak found in:");
    expect(existsSync(stateFile(cwd))).toBe(true);
  });

  it("keeps completed state stable across a repeated invocation", { timeout: 120_000 }, async () => {
    const cwd = await project("single-leak.spec.ts");
    await runCli(cwd);
    const first = await runCli(cwd);
    expect(first.stdout).toContain("We found a leak!");
    const state = await readFile(stateFile(cwd), "utf8");

    const repeated = await runCli(cwd);
    expect(repeated.code).toBe(0);
    expect(repeated.stdout).toContain("We found a leak!");
    expect(await readFile(stateFile(cwd), "utf8")).toBe(state);
  });

  // Regression: both runs load an empty state, write the same state.json.tmp,
  // and one rename can remove the other's temporary file. A user double-clicking
  // the command should get two valid outcomes, never an ENOENT crash.
  it("does not lose a concurrent first-run state save", { timeout: 120_000 }, async () => {
    const cwd = await project("single-leak.spec.ts");
    const [one, two] = await Promise.all([runCli(cwd), runCli(cwd)]);

    expect(one.code, one.stdout + one.stderr).toBe(0);
    expect(two.code, two.stdout + two.stderr).toBe(0);
    expect(await savedState(cwd)).toEqual(singleLeakSnapshot);
  });

  it("reuses transforms across replays without sharing them with another CLI", { timeout: 120_000 }, async () => {
    const cwd = await project("single-leak.spec.ts");
    await writeFile(path.join(cwd, "playwright.config.ts"), 'export default { testDir: ".", outputDir: process.env.CACHE_LOG + ".artifacts" };');
    await appendFile(path.join(cwd, "scenario.spec.ts"), String.raw`
      import { appendFileSync } from "node:fs";
      test.afterAll(() => {
        const cache = process.env.PLAYWRIGHT_TRANSFORM_CACHE_DIR || process.env.PWTEST_CACHE_DIR || "shared";
        appendFileSync(process.env.CACHE_LOG!, cache + "\n");
      });
    `);
    const env = { ...process.env };
    delete env.PLAYWRIGHT_TRANSFORM_CACHE_DIR;
    delete env.PWTEST_CACHE_DIR;
    const cli = path.join(repoRoot, "dist", "cli.mjs");
    const logs = ["first.log", "second.log"].map(file => path.join(cwd, file));
    const runs = await Promise.all(logs.map(log => command(process.execPath, [cli], cwd, { ...env, CACHE_LOG: log })));
    for (const run of runs) expect(run.code, run.stdout + run.stderr).toBe(0);

    const directories = await Promise.all(logs.map(async log => {
      const steps = (await readFile(log, "utf8")).trimEnd().split("\n");
      expect(steps).toEqual([steps[0], steps[0]]);
      expect(existsSync(steps[0]!)).toBe(false);
      return steps[0];
    }));
    expect(directories[0]).not.toBe(directories[1]);
    expect(await savedState(cwd)).toEqual(singleLeakSnapshot);
  });
});
