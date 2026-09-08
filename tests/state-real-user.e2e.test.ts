import { spawn } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const CLI = path.join(repoRoot, "dist", "cli.mjs");
const fixtureRoot = path.join(repoRoot, "tests", "fixtures", "state-workflows");

const stateDirectory = (cwd: string): string =>
  path.join(cwd, ".playwright-leak-finder");
const stateFile = (cwd: string): string => path.join(stateDirectory(cwd), "state.json");
const targetId = /scenario\.spec\.ts › target/u;
const writerId = /scenario\.spec\.ts › writer/u;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * These use copied real Playwright projects and the packaged CLI, rather than
 * a fake runner, because state is meaningful only across separate processes.
 */
describe("persisted state through real user workflows", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterAll(async () => {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
  });

  async function project(spec: "single" | "three" | "combo"): Promise<string> {
    const directory = await mkdtemp(path.join(repoRoot, "tests", ".tmp-state-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await cp(path.join(fixtureRoot, "playwright.config.ts"), path.join(directory, "playwright.config.ts"));
    await cp(
      path.join(
        fixtureRoot,
        spec === "single"
          ? "single-leak.spec.ts"
          : spec === "three"
            ? "three-before-target.spec.ts"
            : "combo-only-leak.spec.ts",
      ),
      path.join(directory, "scenario.spec.ts"),
    );
    return directory;
  }

  function run(cwd: string, ...args: string[]): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  async function savedState(cwd: string): Promise<Record<string, unknown>> {
    // SAFETY: This file is written by FileStateStore in the test's isolated project; values stay unknown for assertions.
    return JSON.parse(await readFile(stateFile(cwd), "utf8")) as Record<string, unknown>;
  }

  const exists = (file: string): Promise<boolean> =>
    access(file).then(
      () => true,
      () => false,
    );

  it("keeps status and reset truthful before, during, and after a search", { timeout: 120_000 }, async () => {
    const cwd = await project("single");

    expect((await run(cwd, "--status")).stdout).toContain("No active search.");

    const started = await run(cwd);
    expect(started.code).toBe(0);
    expect(started.stdout).toMatch(new RegExp(`Target set to: ${targetId.source}`, "u"));
    expect(await exists(stateFile(cwd))).toBe(true);

    const inProgress = await run(cwd, "--status");
    expect(inProgress.code).toBe(0);
    expect(inProgress.stdout).toMatch(new RegExp(`Current target is: ${targetId.source}`, "u"));
    expect(inProgress.stdout).toContain("Next step: a");

    const found = await run(cwd);
    expect(found.code).toBe(0);
    expect(found.stdout).toMatch(new RegExp(`Leak found in: ${writerId.source}`, "u"));

    const completed = await run(cwd, "--status");
    expect(completed.stdout).toMatch(new RegExp(`Current target is: ${targetId.source}`, "u"));

    const reset = await run(cwd, "--reset");
    expect(reset.code).toBe(0);
    expect(reset.stdout).toContain("Leak finder state cleared.");
    expect(await exists(stateFile(cwd))).toBe(false);
    expect((await run(cwd, "--status")).stdout).toContain("No active search.");
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
    const cwd = await project("single");
    await mkdir(stateDirectory(cwd), { recursive: true });
    await writeFile(stateFile(cwd), invalid);

    // State directories normally exist, but corruption can be hand-written by
    // a user or left after a crash. Ensure this covers that exact recovery.
    if (!(await exists(stateFile(cwd)))) {
      throw new Error("test setup did not write state.json");
    }
    const result = await run(cwd);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`Target set to: ${targetId.source}`, "u"));
    expect(await savedState(cwd)).toMatchObject({
      steps: "a",
    });
    expect(String((await savedState(cwd)).target)).toMatch(targetId);
  });

  it("keeps independent searches isolated by each project's cwd", { timeout: 120_000 }, async () => {
    const first = await project("single");
    const second = await project("three");

    await run(first);
    await run(second);
    expect(String((await savedState(first)).target)).toMatch(targetId);
    expect(String((await savedState(second)).target)).toMatch(targetId);
    expect((await savedState(first)).items).toHaveLength(2);
    expect((await savedState(second)).items).toHaveLength(4);

    await run(first, "--reset");
    expect(await exists(stateFile(first))).toBe(false);
    expect(await exists(stateFile(second))).toBe(true);
    expect((await run(second, "--status")).stdout).toContain("Next step: a");
  });

  it("finds a leak when there is exactly one earlier suspect", { timeout: 120_000 }, async () => {
    const cwd = await project("single");
    expect((await run(cwd)).code).toBe(0);

    const result = await run(cwd);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`Leak found in: ${writerId.source}`, "u"));
  });

  it("does not overwrite active state when Playwright cannot start a later step", { timeout: 120_000 }, async () => {
    const cwd = await project("single");
    expect((await run(cwd)).code).toBe(0);
    const before = await readFile(stateFile(cwd), "utf8");

    await writeFile(path.join(cwd, "playwright.config.ts"), "this is not valid TypeScript(");
    const interrupted = await run(cwd);

    expect(interrupted.code).toBe(1);
    expect(await readFile(stateFile(cwd), "utf8")).toBe(before);
    expect((await run(cwd, "--status")).stdout).toContain("Next step: a");
  });

  it("stops inconclusively when a saved file:line snapshot becomes stale", { timeout: 120_000 }, async () => {
    const cwd = await project("three");
    expect((await run(cwd)).code).toBe(0);

    const spec = path.join(cwd, "scenario.spec.ts");
    const original = await readFile(spec, "utf8");
    await writeFile(spec, `\n\n${original}`);

    const result = await run(cwd);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("The target did not run, so this step is inconclusive.");
    expect(result.stdout).toMatch(new RegExp(`Current target is: ${targetId.source}`, "u"));
  });

  it("stops inconclusively when the snapshot's spec file is moved", { timeout: 120_000 }, async () => {
    const cwd = await project("three");
    expect((await run(cwd)).code).toBe(0);

    await rename(path.join(cwd, "scenario.spec.ts"), path.join(cwd, "renamed.spec.ts"));
    const result = await run(cwd);

    expect(result.code).toBe(2);
    expect(result.stdout).toContain("The target did not run, so this step is inconclusive.");
  });

  it("reports a combination-only leak as inconclusive instead of blaming either test", { timeout: 120_000 }, async () => {
    const cwd = await project("combo");

    const result = await run(cwd, "--auto");
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "The search cannot narrow any further: no single earlier test makes the target fail.",
    );
    expect(result.stdout).not.toContain("Leak found in:");
  });

  it("keeps completed state stable across a repeated invocation", { timeout: 120_000 }, async () => {
    const cwd = await project("single");
    await run(cwd);
    const first = await run(cwd);
    expect(first.stdout).toContain("We found a leak!");
    const state = await readFile(stateFile(cwd), "utf8");

    const repeated = await run(cwd);
    expect(repeated.code).toBe(0);
    expect(repeated.stdout).toContain("We found a leak!");
    expect(await readFile(stateFile(cwd), "utf8")).toBe(state);
  });

  // Regression: both runs load an empty state, write the same state.json.tmp,
  // and one rename can remove the other's temporary file. A user double-clicking
  // the command should get two valid outcomes, never an ENOENT crash.
  it("does not lose a concurrent first-run state save", { timeout: 120_000 }, async () => {
    const cwd = await project("single");
    const [one, two] = await Promise.all([run(cwd), run(cwd)]);

    expect(one.code).toBe(0);
    expect(two.code).toBe(0);
    expect(await savedState(cwd)).toMatchObject({
      steps: "a",
    });
    expect(String((await savedState(cwd)).target)).toMatch(targetId);
  });
});
