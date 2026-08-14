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

  it("lets the last command win when several are given", () => {
    expect(parseCliArgs(["--reset", "--status"]).command).toBe("status");
    expect(parseCliArgs(["--status", "--reset"]).command).toBe("reset");
  });

  it("recognizes --auto wherever it appears, and only once", () => {
    expect(parseCliArgs(["--config", "demo", "--auto"])).toEqual({
      command: "run",
      auto: true,
      playwrightArgs: ["--config", "demo"],
    });
    expect(parseCliArgs(["--auto", "--auto"]).playwrightArgs).toEqual([]);
  });

  it("does not consume --auto as a value of the option before it", () => {
    // `--grep --auto` is a user typo, not a request for automatic mode. The
    // parser is flat, so document that --auto always wins: the forwarded
    // --grep then has no value and Playwright reports it.
    expect(parseCliArgs(["--grep", "--auto"])).toEqual({
      command: "run",
      auto: true,
      playwrightArgs: ["--grep"],
    });
  });

  it.each([
    ["an empty string", [""], [""]],
    ["a lone separator", ["--"], ["--"]],
    ["a value that looks like a command", ["--grep", "--reset-ish"], ["--grep", "--reset-ish"]],
  ])("forwards %s verbatim", (_name, argv, expected) => {
    expect(parseCliArgs(argv)).toEqual({
      command: "run",
      auto: false,
      playwrightArgs: expected,
    });
  });

  it("keeps the forwarded argument order", () => {
    const argv = ["--grep", "a", "--auto", "--project", "b", "--headed"];
    expect(parseCliArgs(argv).playwrightArgs).toEqual([
      "--grep",
      "a",
      "--project",
      "b",
      "--headed",
    ]);
  });
});
