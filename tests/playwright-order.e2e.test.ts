import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { PlaywrightRunner } from "playwright-leak-finder";
import { createProject, runCli } from "./e2e-helpers";

it("does not advance a search when registration order changes at the same source lines", { timeout: 120_000 }, async () => {
  const spec = [
    'const { test, expect } = require("@playwright/test");',
    "let leaked = false;",
    'const registerA = () => test("A", () => { leaked = true; });',
    'const registerB = () => test("B", () => {});',
    "registerA(); registerB();",
    'test("C", () => {});',
    'test("D", () => {});',
    'test("target", () => expect(leaked).toBe(false));',
  ].join("\n");
  const cwd = await createProject({ "order.spec.cjs": spec });
  const capture = await runCli(cwd);
  expect(capture.code, capture.stderr).toBe(0);
  expect(capture.stdout).toContain("Target set to: order.spec.cjs › target");
  const stateFile = path.join(cwd, ".playwright-leak-finder", "state.json");
  const captured = await readFile(stateFile, "utf8");

  const reordered = spec.replace("registerA(); registerB();", "registerB(); registerA();");
  await writeFile(path.join(cwd, "order.spec.cjs"), reordered);
  const replay = await runCli(cwd);
  expect(replay.code, replay.stdout + replay.stderr).toBe(2);
  expect(replay.stdout).toContain("inconclusive");
  expect(await readFile(stateFile, "utf8")).toBe(captured);
});

it("lists in registration order but reports a run in observed worker order", { timeout: 120_000 }, async () => {
  const cwd = await createProject({
    "groups.spec.cjs": [
      'const { test } = require("@playwright/test");',
      'const { appendFileSync } = require("node:fs");',
      'test.beforeEach(({}, info) => appendFileSync("ran.txt", info.title + "\\n"));',
      'const middle = () => test.describe.parallel("group", () => test("middle", () => {}));',
      'test("first", () => {});',
      "middle();",
      'test("last", () => {});',
    ].join("\n"),
  });
  const runner = new PlaywrightRunner({ cwd });
  expect((await runner.list()).map((item) => item.id)).toEqual([
    "groups.spec.cjs › first",
    "groups.spec.cjs › group › middle",
    "groups.spec.cjs › last",
  ]);

  const run = await runner.run({ quiet: true });
  expect(run.exitCode).toBe(0);
  const observed = (await readFile(path.join(cwd, "ran.txt"), "utf8")).trim().split("\n");
  expect(run.results.map((item) => item.id.split(" › ").at(-1))).toEqual(observed);
});

it("combines configured repeats without merging distinct declarations with the same display ID", { timeout: 120_000 }, async () => {
  const cwd = await createProject({
    "playwright.config.cjs": "module.exports = { repeatEach: 3 };",
    "declare.cjs": [
      'const { test } = require("@playwright/test");',
      "module.exports = (title, body) => test(title, body);",
    ].join("\n"),
    "a.spec.cjs": [
      'const { test, expect } = require("@playwright/test");',
      'const declare = require("./declare.cjs");',
      'declare("group › item", ({}, info) => {',
      "  test.skip(info.repeatEachIndex === 2);",
      "  expect(info.repeatEachIndex).toBe(0);", // pass, fail, skip
      "});",
    ].join("\n"),
    "b.spec.cjs": [
      'const { test } = require("@playwright/test");',
      'const declare = require("./declare.cjs");',
      'test.describe("group", () => declare("item", ({}, info) => {',
      "  test.skip(info.repeatEachIndex !== 1);", // skip, pass, skip
      "}));",
    ].join("\n"),
  });
  const runner = new PlaywrightRunner({ cwd });
  const item = { id: "declare.cjs › group › item", file: "declare.cjs", line: 2 };
  expect(await runner.list()).toEqual([item, item]);
  const outcome = await runner.run({ quiet: true });
  expect(outcome).toEqual({
    exitCode: 1,
    results: [{ ...item, status: "failed" }, { ...item, status: "passed" }],
  });
});
