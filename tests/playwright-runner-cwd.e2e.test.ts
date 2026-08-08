import path from "node:path";
import { describe, expect, it } from "vitest";
import { PlaywrightRunner } from "playwright-leak-finder";

describe("PlaywrightRunner consumer cwd", () => {
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
