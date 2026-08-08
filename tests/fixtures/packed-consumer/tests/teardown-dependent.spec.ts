import { expect, test } from "@playwright/test";

const state: string[] = [];

test.describe.serial("project with failing teardown", () => {
  test("leaker", () => {
    state.push("leak");
  });

  test("victim", () => {
    expect(state).toEqual([]);
  });
});
