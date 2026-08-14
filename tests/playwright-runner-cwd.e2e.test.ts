import path from "node:path";
import { describe, expect, it } from "vitest";
import { PlaywrightRunner } from "playwright-leak-finder";

describe("PlaywrightRunner consumer cwd", () => {
  it("rejects when the child cannot be spawned at all", { timeout: 60_000 }, async () => {
    // A path that resolves @playwright/test from an ancestor but is not a
    // directory: argument checks and CLI resolution both pass, then spawn
    // itself fails. That error has to surface rather than hang the search.
    const notADirectory = path.join(
      process.cwd(),
      "tests",
      "fixtures",
      "packed-consumer",
      "package.json",
    );

    await expect(
      new PlaywrightRunner({ cwd: notADirectory }).list([]),
    ).rejects.toThrow(/ENOTDIR/u);
  });


  it("accepts a relative project cwd", { timeout: 120_000 }, async () => {
    // The constructor advertises `cwd` as a consumer project directory. A
    // relative directory is normal Node process input and should resolve from
    // the caller's current working directory.
    const relativeFixture = path.relative(
      process.cwd(),
      path.join(process.cwd(), "tests", "fixtures", "packed-consumer"),
    );

    await expect(
      new PlaywrightRunner({ cwd: relativeFixture }).list([
        "--config",
        "playwright.config.ts",
        "--project",
        "isolated",
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ id: "isolated.spec.ts › serial user workflow › temporarily disabled check" }),
      expect.objectContaining({ id: "isolated.spec.ts › serial user workflow › unfinished check" }),
      expect.objectContaining({ id: "isolated.spec.ts › serial user workflow › preflight" }),
      expect.objectContaining({ id: "isolated.spec.ts › serial user workflow › nested flow › leaks selected state" }),
      expect.objectContaining({ id: "isolated.spec.ts › serial user workflow › nested flow › reports a clean state" }),
    ]);
  });
});
