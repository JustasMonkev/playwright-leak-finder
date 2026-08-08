import { expect, test } from "@playwright/test";

test("fails after the selected project ran", () => {
  expect("cleanup failed").toBe("cleanup ready");
});
