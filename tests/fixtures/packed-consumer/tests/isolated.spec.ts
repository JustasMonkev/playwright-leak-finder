import { expect, test } from "@playwright/test";

const state: string[] = [];

test.describe.serial("serial user workflow", () => {
  test.skip("temporarily disabled check", () => {
    throw new Error("A skipped test must not execute");
  });

  test.fixme("unfinished check", () => {
    throw new Error("A fixme test must not execute");
  });

  test("preflight", () => {
    expect(state).toEqual([]);
  });

  test.describe("nested flow", () => {
    test("leaks selected state", () => {
      state.push("selected");
    });

    test("reports a clean state", () => {
      expect(state).toEqual([]);
    });
  });
});
