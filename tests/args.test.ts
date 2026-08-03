import { describe, expect, it } from "vitest";
import { parseCliArgs } from "playwright-leak-finder";

describe("parseCliArgs", () => {
  it("defaults to the run command", () => {
    expect(parseCliArgs([])).toEqual({ command: "run", auto: false, playwrightArgs: [] });
  });

  it("forwards unknown arguments to playwright", () => {
    expect(parseCliArgs(["--config", "demo", "--project=chromium"])).toEqual({
      command: "run",
      auto: false,
      playwrightArgs: ["--config", "demo", "--project=chromium"],
    });
  });

  it("recognizes --auto without forwarding it", () => {
    expect(parseCliArgs(["--auto", "--config", "demo"])).toEqual({
      command: "run",
      auto: true,
      playwrightArgs: ["--config", "demo"],
    });
  });

  it.each([
    [["--reset"], "reset"],
    [["--status"], "status"],
    [["--help"], "help"],
    [["-h"], "help"],
  ])("recognizes %j as the %s command", (argv, command) => {
    expect(parseCliArgs(argv).command).toBe(command);
  });
});
