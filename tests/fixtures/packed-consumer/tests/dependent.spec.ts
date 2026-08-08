import { expect, test } from "@playwright/test";

const state: string[] = [];

test.describe.serial("project with setup dependency", () => {
  test("leaker", () => {
    state.push("leak");
  });

  test("victim", () => {
    expect(state).toEqual([]);
  });
});
