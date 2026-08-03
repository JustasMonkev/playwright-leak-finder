import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FileStateStore,
  LeakFinder,
  PlaywrightRunner,
} from "playwright-leak-finder";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");

// Runs the real `playwright test` CLI against a copy of the leaky
// fixture suite.
// The fixture lives inside the repo so the spec can resolve @playwright/test.
describe("leak finder against a real Playwright project", () => {
  let fixtureDir: string;
  let finder: LeakFinder;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(path.join(repoRoot, "tests", ".tmp-fixture-"));
    await cp(path.join(repoRoot, "tests", "fixtures", "leaky-suite"), fixtureDir, {
      recursive: true,
    });
    finder = new LeakFinder(
      new PlaywrightRunner({ cwd: fixtureDir }),
      new FileStateStore(path.join(fixtureDir, ".playwright-leak-finder")),
    );
  });

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("finds the leaking test in three runs", { timeout: 180_000 }, async () => {
    const first = await finder.run();
    expect(first.done).toBe(false);
    expect(first.lines).toEqual([
      "Target set to: demo.spec.ts › test5",
      "Suspects remaining: 4",
      "Run the same command again to bisect the tests before the target.",
    ]);

    const second = await finder.run();
    expect(second.lines[0]).toBe(
      "We reached the target and nothing failed. Let's bisect the other half.",
    );
    expect(second.lines).toContain("Suspects remaining: 2");
    expect(second.done).toBe(false);

    const third = await finder.run();
    expect(third.leakCandidate).toBe("demo.spec.ts › test3");
    expect(third.done).toBe(true);
    expect(third.lines).toEqual([
      "We found a leak!",
      "Leak found in: demo.spec.ts › test3",
      "This search is finished but its state is still saved: run --reset before starting another one.",
    ]);
  });

  it("does not select a sibling file sharing a filter suffix", { timeout: 180_000 }, async () => {
    // A bare `nav.spec.ts:3` filter is an unanchored regex to Playwright, so
    // it would also select main-nav.spec.ts:3. The runner must anchor it.
    const spec = [
      'import { test } from "@playwright/test";',
      "",
      'test("nav works", () => {});',
      "",
    ].join("\n");
    await writeFile(path.join(fixtureDir, "nav.spec.ts"), spec);
    await writeFile(path.join(fixtureDir, "main-nav.spec.ts"), spec);

    const outcome = await new PlaywrightRunner({ cwd: fixtureDir }).run({
      locations: [{ file: "nav.spec.ts", line: 3 }],
      quiet: true,
    });

    expect(outcome.results.map((result) => result.id)).toEqual([
      "nav.spec.ts › nav works",
    ]);
  });

  it("selects a file reported relative to a rootDir it sits outside of", { timeout: 180_000 }, async () => {
    // A project testDir outside the top-level testDir makes Playwright report
    // files as `../outside/out.spec.ts`; the literal `..` never appears in the
    // absolute path a filter regex is matched against.
    await mkdir(path.join(fixtureDir, "outside"), { recursive: true });
    await writeFile(
      path.join(fixtureDir, "outside", "out.spec.ts"),
      [
        'import { test } from "@playwright/test";',
        "",
        'test("out works", () => {});',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(fixtureDir, "escape.config.ts"),
      'import { defineConfig } from "@playwright/test";\n' +
        'export default defineConfig({ testDir: "./specs", ' +
        'projects: [{ name: "out", testDir: "./outside" }] });\n',
    );

    const outcome = await new PlaywrightRunner({ cwd: fixtureDir }).run({
      locations: [{ file: "../outside/out.spec.ts", line: 3 }],
      passthroughArgs: ["--config", "escape.config.ts"],
      quiet: true,
    });

    expect(outcome.results.map((result) => result.id)).toEqual([
      "../outside/out.spec.ts › out works",
    ]);
  });

  it("forwards passthrough arguments to playwright", async () => {
    const items = await new PlaywrightRunner({ cwd: fixtureDir }).list([
      "--grep",
      "test3",
    ]);

    expect(items.map((item) => item.id)).toEqual(["demo.spec.ts › test3"]);
  });

  it("refuses a run covering several projects", async () => {
    // Every spec is reported once per project, so there is no single order.
    await writeFile(
      path.join(fixtureDir, "mp.config.ts"),
      'import { defineConfig } from "@playwright/test";\n' +
        'export default defineConfig({ testDir: ".", ' +
        'projects: [{ name: "alpha" }, { name: "beta" }] });\n',
    );

    await expect(
      new PlaywrightRunner({ cwd: fixtureDir }).list(["--config", "mp.config.ts"]),
    ).rejects.toThrow(/covers 2 Playwright projects .*Re-run with --project/s);
  });

  it("collects tests in declaration order across describe blocks", async () => {
    // Playwright reports a suite's own specs and its describe blocks in
    // separate arrays, so a naive walk would put `middle` last.
    await writeFile(
      path.join(fixtureDir, "ordering.spec.ts"),
      [
        'import { test } from "@playwright/test";',
        'test("first", () => {});',
        'test.describe("group", () => {',
        '  test("middle", () => {});',
        "});",
        'test("last", () => {});',
        "",
      ].join("\n"),
    );

    const items = await new PlaywrightRunner({ cwd: fixtureDir }).list([
      "--grep",
      "first|middle|last",
    ]);

    expect(items.map((item) => item.id)).toEqual([
      "ordering.spec.ts › first",
      "ordering.spec.ts › group › middle",
      "ordering.spec.ts › last",
    ]);
  });
});

// Leak positions the unit tests only cover with fakes, replayed against real
// playwright: leak first (fail-descend), leak last (smallest pool), and a
// leak inside a describe block (nested suite ids).
describe("hunt scenarios against a real Playwright project", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });

  const CONFIG =
    'import { defineConfig } from "@playwright/test";\n' +
    'export default defineConfig({ testDir: "." });\n';

  async function huntFixture(
    files: Record<string, string>,
  ): Promise<{ finder: LeakFinder; store: FileStateStore }> {
    const dir = await mkdtemp(path.join(repoRoot, "tests", ".tmp-fixture-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(dir, name), content);
    }
    const store = new FileStateStore(path.join(dir, ".playwright-leak-finder"));
    return {
      finder: new LeakFinder(new PlaywrightRunner({ cwd: dir }), store),
      store,
    };
  }

  it("finds a leak in the first test by descending 'a' every step", { timeout: 180_000 }, async () => {
    const spec = [
      'import { expect, test } from "@playwright/test";',
      "",
      "const leakState: string[] = [];",
      "",
      'test("test1", () => {',
      '  leakState.push("leak");',
      "});",
      'test("test2", () => {});',
      'test("test3", () => {});',
      'test("test4", () => {});',
      'test("test5", () => {});',
      'test("test6", () => {',
      "  expect(leakState).toEqual([]);",
      "});",
      "",
    ].join("\n");
    const { finder, store } = await huntFixture({
      "playwright.config.ts": CONFIG,
      "first.spec.ts": spec,
    });

    const capture = await finder.run();
    expect(capture.lines[0]).toBe("Target set to: first.spec.ts › test6");
    expect(capture.done).toBe(false);

    // The leak is the very first test, so every step keeps the "a" half.
    const second = await finder.run();
    expect(second.done).toBe(false);
    expect(second.lines[0]).toBe(
      "The group selected still fails. Let's do a new partition.",
    );
    expect((await store.load()).steps).toBe("aa");

    const third = await finder.run();
    expect(third.done).toBe(false);
    expect((await store.load()).steps).toBe("aaa");

    const fourth = await finder.run();
    expect(fourth.done).toBe(true);
    expect(fourth.leakCandidate).toBe("first.spec.ts › test1");
  });

  it("finds a leak in the test right before the target", { timeout: 120_000 }, async () => {
    const spec = [
      'import { expect, test } from "@playwright/test";',
      "",
      "const leakState: string[] = [];",
      "",
      'test("leaker", () => {',
      '  leakState.push("leak");',
      "});",
      'test("victim", () => {',
      "  expect(leakState).toEqual([]);",
      "});",
      "",
    ].join("\n");
    const { finder } = await huntFixture({
      "playwright.config.ts": CONFIG,
      "pair.spec.ts": spec,
    });

    const capture = await finder.run();
    expect(capture.lines[0]).toBe("Target set to: pair.spec.ts › victim");
    expect(capture.lines).toContain("Suspects remaining: 1");

    const result = await finder.run();
    expect(result.done).toBe(true);
    expect(result.leakCandidate).toBe("pair.spec.ts › leaker");
  });

  it("finds a leak inside a describe block", { timeout: 120_000 }, async () => {
    const spec = [
      'import { expect, test } from "@playwright/test";',
      "",
      "const leakState: string[] = [];",
      "",
      'test.describe("group", () => {',
      '  test("leaker", () => {',
      '    leakState.push("leak");',
      "  });",
      '  test("victim", () => {',
      "    expect(leakState).toEqual([]);",
      "  });",
      "});",
      "",
    ].join("\n");
    const { finder } = await huntFixture({
      "playwright.config.ts": CONFIG,
      "desc.spec.ts": spec,
    });

    const capture = await finder.run();
    expect(capture.lines[0]).toBe("Target set to: desc.spec.ts › group › victim");
    expect(capture.done).toBe(false);

    const result = await finder.run();
    expect(result.done).toBe(true);
    expect(result.leakCandidate).toBe("desc.spec.ts › group › leaker");
  });
});
