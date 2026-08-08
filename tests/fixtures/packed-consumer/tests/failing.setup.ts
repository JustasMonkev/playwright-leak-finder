import { expect, test } from "@playwright/test";

test("fails to create the prerequisite", () => {
  expect("setup failed").toBe("setup ready");
});
