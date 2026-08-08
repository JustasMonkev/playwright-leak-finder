import { expect, test } from "@playwright/test";

const shared: string[] = [];

test("first half", () => {
  shared.push("first");
});

test("second half", () => {
  shared.push("second");
});

test("target", () => {
  expect(shared.includes("first") && shared.includes("second")).toBe(false);
});
