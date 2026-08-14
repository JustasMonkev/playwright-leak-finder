import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
  ): Promise<{ finder: LeakFinder; store: FileStateStore; dir: string }> {
    const dir = await mkdtemp(path.join(repoRoot, "tests", ".tmp-fixture-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dir, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    const store = new FileStateStore(path.join(dir, ".playwright-leak-finder"));
    return {
      finder: new LeakFinder(new PlaywrightRunner({ cwd: dir }), store),
      store,
      dir,
    };
  }

  /** Runs steps until the search finishes, like the CLI's `--auto`. */
  async function hunt(finder: LeakFinder, limit = 20) {
    let report = await finder.run();
    for (let step = 0; step < limit && !report.done; step += 1) {
      report = await finder.run();
    }
    expect(report.done).toBe(true);
    return report;
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

  it("keeps overlapping runs from reading each other's report", { timeout: 180_000 }, async () => {
    // Each run writes its JSON report to its own temporary directory. A shared
    // path would let two overlapping runs read back the other's results, and
    // the search would draw its conclusion from a run it never asked for.
    //
    // Each run gets its own project directory: several `playwright test`
    // processes sharing one directory race on that project's output directory
    // and transform cache, which is Playwright's constraint rather than
    // anything this test is about.
    const projects = await Promise.all(
      ["alpha", "beta"].map(async (name) => {
        const { dir } = await huntFixture({
          "playwright.config.ts": CONFIG,
          [`${name}.spec.ts`]: [
            'import { test } from "@playwright/test";',
            `test("${name} one", async () => { await new Promise((r) => setTimeout(r, 300)); });`,
            `test("${name} two", async () => { await new Promise((r) => setTimeout(r, 300)); });`,
            "",
          ].join("\n"),
        });
        return { name, runner: new PlaywrightRunner({ cwd: dir }) };
      }),
    );
    const listeners = () =>
      process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
    const before = listeners();

    const outcomes = await Promise.all(
      projects.map(({ name, runner }) =>
        runner.run({
          locations: [{ file: `${name}.spec.ts`, line: 2 }],
          quiet: true,
        }),
      ),
    );

    expect(outcomes.map((outcome) => outcome.results.map((result) => result.id))).toEqual([
      ["alpha.spec.ts › alpha one"],
      ["beta.spec.ts › beta one"],
    ]);
    // Every run installs signal handlers; none may outlive its own child.
    expect(listeners()).toBe(before);
  });

  it("finds a leak that crosses spec files", { timeout: 180_000 }, async () => {
    // The premise of the whole search is that files execute in the order the
    // JSON report lists them. A single-file fixture cannot show that; the
    // real-world case always spans files.
    const { finder } = await huntFixture({
      "playwright.config.ts": CONFIG,
      "shared-state.ts": "export const shared: string[] = [];\n",
      "a-first.spec.ts": [
        'import { test } from "@playwright/test";',
        'import { shared } from "./shared-state";',
        'test("a1", () => {});',
        'test("a2 leaks", () => { shared.push("leak"); });',
        "",
      ].join("\n"),
      "b-middle.spec.ts": [
        'import { test } from "@playwright/test";',
        'test("b1", () => {});',
        'test("b2", () => {});',
        "",
      ].join("\n"),
      "c-last.spec.ts": [
        'import { expect, test } from "@playwright/test";',
        'import { shared } from "./shared-state";',
        'test("c1", () => {});',
        'test("c2 victim", () => { expect(shared).toEqual([]); });',
        "",
      ].join("\n"),
    });

    const capture = await finder.run();
    expect(capture.lines[0]).toBe("Target set to: c-last.spec.ts › c2 victim");
    expect(capture.lines).toContain("Suspects remaining: 5");

    expect((await hunt(finder)).leakCandidate).toBe("a-first.spec.ts › a2 leaks");
  });

  it("blames a skipped test whose hook leaked before it skipped", { timeout: 180_000 }, async () => {
    // A test that reports as "skipped" is not automatically innocent: a
    // runtime `test.skip()` runs after its beforeEach. That is why skipped
    // tests stay in the suspect pool and are counted as suspects — dropping
    // them to make the count prettier would lose this leak entirely.
    const { finder } = await huntFixture({
      "playwright.config.ts": CONFIG,
      "hook.spec.ts": [
        'import { expect, test } from "@playwright/test";',
        "const shared: string[] = [];",
        'test("innocent", () => {});',
        'test.describe("group", () => {',
        '  test.beforeEach(() => { shared.push("leak-from-hook"); });',
        '  test("runtime skipped", () => {',
        '    test.skip(true, "skipped only after its hook already ran");',
        "  });",
        "});",
        'test("victim", () => { expect(shared).toEqual([]); });',
        "",
      ].join("\n"),
    });

    const capture = await finder.run();
    expect(capture.lines).toContain("Suspects remaining: 2");

    expect((await hunt(finder)).leakCandidate).toBe(
      "hook.spec.ts › group › runtime skipped",
    );
  });

  it("finds a leak past skipped and fixme tests", { timeout: 180_000 }, async () => {
    // Playwright reports these with results but a skipped status. They must
    // stay in the ordered pool — dropping them would shift every later index
    // and hand back the wrong neighbour.
    const { finder } = await huntFixture({
      "playwright.config.ts": CONFIG,
      "skips.spec.ts": [
        'import { expect, test } from "@playwright/test";',
        "const shared: string[] = [];",
        'test("one", () => {});',
        'test.skip("skipped two", () => { throw new Error("must not run"); });',
        'test("three leaks", () => { shared.push("leak"); });',
        'test.fixme("fixme four", () => { throw new Error("must not run"); });',
        'test("five", () => {});',
        'test("victim", () => { expect(shared).toEqual([]); });',
        "",
      ].join("\n"),
    });

    const capture = await finder.run();
    expect(capture.lines).toContain("Suspects remaining: 5");

    expect((await hunt(finder)).leakCandidate).toBe("skips.spec.ts › three leaks");
  });

  it("finds a leak through paths and titles full of regex and shell metacharacters", { timeout: 180_000 }, async () => {
    // `file:line` filters are regexes to Playwright and the CLI is spawned
    // without a shell. Both have to hold at once: unescaped `+`/`[` would
    // select the wrong file, and a shell would execute the `$(...)` in a name.
    const specPath = "sub dir(1)/a+b [x] $(touch owned).spec.ts";
    const { finder, dir } = await huntFixture({
      "playwright.config.ts": CONFIG,
      "shared-state.ts": "export const shared: string[] = [];\n",
      [specPath]: [
        'import { expect, test } from "@playwright/test";',
        'import { shared } from "../shared-state";',
        'test("plain one", () => {});',
        'test("leaker 🎉 ünïcode `touch owned`; rm -rf .", () => { shared.push("leak"); });',
        'test("víctim — emoji 🚀 $(touch owned)", () => { expect(shared).toEqual([]); });',
        "",
      ].join("\n"),
    });

    const capture = await finder.run();
    expect(capture.lines[0]).toBe(
      `Target set to: ${specPath} › víctim — emoji 🚀 $(touch owned)`,
    );

    expect((await hunt(finder)).leakCandidate).toBe(
      `${specPath} › leaker 🎉 ünïcode \`touch owned\`; rm -rf .`,
    );
    // No shell ever saw those names.
    for (const parent of [dir, path.join(dir, "sub dir(1)")]) {
      expect(await readdir(parent)).not.toContain("owned");
    }
  });

  it("treats a flaky target as reproduced rather than passing", { timeout: 180_000 }, async () => {
    // A project config can set retries; the CLI refuses to change that. A
    // target that fails then passes on retry is reported "flaky", and the leak
    // did reproduce — reading it as a pass sends the search into the half that
    // is innocent.
    const { finder } = await huntFixture({
      "playwright.config.ts":
        'import { defineConfig } from "@playwright/test";\n' +
        'export default defineConfig({ testDir: ".", retries: 1 });\n',
      "flaky.spec.ts": [
        'import { expect, test } from "@playwright/test";',
        "const shared: string[] = [];",
        'test("leaker", () => { shared.push("leak"); });',
        'test("victim", () => {',
        "  const seen = [...shared];",
        // Self-healing: the retry sees clean state and passes.
        "  shared.length = 0;",
        "  expect(seen).toEqual([]);",
        "});",
        "",
      ].join("\n"),
    });

    const capture = await finder.run();
    expect(capture.lines[0]).toBe("Target set to: flaky.spec.ts › victim");
    expect(capture.done).toBe(false);

    expect((await hunt(finder)).leakCandidate).toBe("flaky.spec.ts › leaker");
  });

  it("stops the capture run at the target instead of running the rest of the suite", { timeout: 180_000 }, async () => {
    // The capture run defines the target as the first failure and every
    // suspect as a test that passed before it. Letting the suite continue
    // would break that premise and pay for a full run the search cannot use.
    const { finder, dir } = await huntFixture({
      "playwright.config.ts": CONFIG,
      "order.spec.ts": [
        'import { writeFileSync } from "node:fs";',
        'import { expect, test } from "@playwright/test";',
        "const shared: string[] = [];",
        'test("one", () => {});',
        'test("two leaks", () => { shared.push("leak"); });',
        'test("victim", () => { expect(shared).toEqual([]); });',
        'test("later failure", () => {',
        '  writeFileSync("later-ran.marker", "ran");',
        "  expect(1).toBe(2);",
        "});",
        "",
      ].join("\n"),
    });

    const capture = await finder.run();

    expect(capture.lines[0]).toBe("Target set to: order.spec.ts › victim");
    expect(capture.lines).toContain("Suspects remaining: 2");
    expect(await readdir(dir)).not.toContain("later-ran.marker");
  });

  it("refuses to answer when several suspects share a file:line", { timeout: 180_000 }, async () => {
    // Loop-generated tests all report the line of the `test(...)` call, so a
    // `file:line` filter selects siblings the step never chose. Naming one of
    // them as the leak would be a confident wrong answer.
    const { finder } = await huntFixture({
      "playwright.config.ts": CONFIG,
      "loop.spec.ts": [
        'import { expect, test } from "@playwright/test";',
        "const shared: string[] = [];",
        "for (const n of [1, 2, 3, 4]) {",
        '  test(`generated ${n}`, () => { if (n === 2) shared.push("leak"); });',
        "}",
        'test("victim", () => { expect(shared).toEqual([]); });',
        "",
      ].join("\n"),
    });

    const capture = await finder.run();
    expect(capture.lines[0]).toBe("Target set to: loop.spec.ts › victim");

    const report = await hunt(finder);
    expect(report.leakCandidate).toBeNull();
    expect(report.lines).toEqual([
      "The tests that ran are not the ones selected, so this step is inconclusive.",
      "Either a spec file changed lines since the search started, or several tests share a file:line.",
      "Run --reset to start over.",
    ]);
  });

  it("refuses to answer when a later step narrows the run further", { timeout: 180_000 }, async () => {
    // Sibling of the file:line clash above, from the other direction: fewer
    // tests ran than were selected. Adding a --grep between invocations is an
    // easy mistake, and the half of the pool it silences would otherwise look
    // exactly like a half that contains no leak.
    const { finder } = await huntFixture({
      "playwright.config.ts": CONFIG,
      "grep.spec.ts": [
        'import { expect, test } from "@playwright/test";',
        "const shared: string[] = [];",
        'test("alpha one", () => {});',
        'test("alpha two", () => {});',
        'test("beta three leaks", () => { shared.push("leak"); });',
        'test("beta four", () => {});',
        'test("victim", () => { expect(shared).toEqual([]); });',
        "",
      ].join("\n"),
    });

    const capture = await finder.run();
    expect(capture.lines).toContain("Suspects remaining: 4");

    // Step "a" selects alpha one, alpha two and the target; the grep silences
    // alpha two while leaving the target running, so the step is unusable.
    const report = await finder.run(["--grep", "alpha one|victim"]);

    expect(report.done).toBe(true);
    expect(report.leakCandidate).toBeNull();
    expect(report.lines[0]).toBe(
      "The tests that ran are not the ones selected, so this step is inconclusive.",
    );
  });

  it("refuses to answer when a suspect is renamed under the snapshot", { timeout: 180_000 }, async () => {
    // The count still matches and the target still runs, so only comparing
    // which tests ran catches this: `file:line` now points at a different
    // test, and the snapshot's suspect never executed at all.
    const spec = (firstTitle: string): string =>
      [
        'import { expect, test } from "@playwright/test";',
        "const shared: string[] = [];",
        `test("${firstTitle}", () => {});`,
        'test("two leaks", () => { shared.push("leak"); });',
        'test("three", () => {});',
        'test("victim", () => { expect(shared).toEqual([]); });',
        "",
      ].join("\n");
    const { finder, dir } = await huntFixture({
      "playwright.config.ts": CONFIG,
      "rename.spec.ts": spec("one"),
    });

    const capture = await finder.run();
    expect(capture.lines).toContain("Suspects remaining: 3");

    // Same file, same line count: only the title on the selected line moved.
    await writeFile(path.join(dir, "rename.spec.ts"), spec("one renamed"));
    const report = await finder.run();

    expect(report.done).toBe(true);
    expect(report.leakCandidate).toBeNull();
    expect(report.lines[0]).toBe(
      "The tests that ran are not the ones selected, so this step is inconclusive.",
    );
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
