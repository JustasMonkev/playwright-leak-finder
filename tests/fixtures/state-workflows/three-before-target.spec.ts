import { expect, test } from "@playwright/test";

const shared: string[] = [];

test("innocent one", () => {});

test("writer", () => {
  shared.push("leak");
});

test("innocent two", () => {});

test("target", () => {
  expect(shared).toEqual([]);
});
