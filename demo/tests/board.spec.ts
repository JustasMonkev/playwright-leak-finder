import { expect, test } from "@playwright/test";

// Everyday UI tests. Each one deletes the tasks it created, so none of them
// leaves anything behind for the tests that follow.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("adds a task from the form", async ({ page }) => {
  await page.getByLabel("Task title").fill("Write the release notes");
  await page.getByRole("button", { name: "Add task" }).click();

  await expect(page.getByText("Write the release notes")).toBeVisible();

  await page.getByRole("button", { name: "Delete: Write the release notes" }).click();
  await expect(page.getByText("Write the release notes")).toBeHidden();
});

test("marks a task as done", async ({ page }) => {
  await page.getByLabel("Task title").fill("Ship the changelog");
  await page.getByRole("button", { name: "Add task" }).click();

  const count = page.locator("#count");
  await expect(page.getByText("Ship the changelog")).toBeVisible();
  const open = Number((await count.innerText()).replace("Open tasks: ", ""));

  await page.getByLabel("Done: Ship the changelog").check();
  await expect(count).toHaveText(`Open tasks: ${open - 1}`);

  await page.getByRole("button", { name: "Delete: Ship the changelog" }).click();
  await expect(page.getByText("Ship the changelog")).toBeHidden();
});
