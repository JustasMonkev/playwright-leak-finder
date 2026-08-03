import { expect, test } from "@playwright/test";

// Shared module state: test3 pollutes it, which makes test5 fail whenever
// test3 ran earlier in the same worker. Use this suite to try the leak finder:
//
//   npx playwright-leak-finder --config demo
const leakState: string[] = [];

test("test1", () => {
  expect(true).toBeTruthy();
});

test("test2", () => {
  expect(true).toBeTruthy();
});

test("test3", () => {
  leakState.push("leak");
  expect(true).toBeTruthy();
});

test("test4", () => {
  expect(true).toBeTruthy();
});

test("test5", () => {
  expect(leakState).toEqual([]);
});

test("test6", () => {
  expect(true).toBeTruthy();
});
