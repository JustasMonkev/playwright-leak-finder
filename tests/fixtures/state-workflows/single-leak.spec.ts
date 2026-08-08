import { expect, test } from "@playwright/test";

const shared: string[] = [];

test("writer", () => {
  shared.push("leak");
});

test("target", () => {
  expect(shared).toEqual([]);
});
