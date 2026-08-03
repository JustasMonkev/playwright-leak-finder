import { expect, test } from "@playwright/test";

test("reports an empty board", async ({ page }) => {
  // Passes on its own, fails in the full suite: something earlier left tasks
  // on the board. Which test? That is what the leak finder answers.
  await page.goto("/");

  await expect(page.locator("#count")).toHaveText("Open tasks: 0");
  await expect(page.getByRole("listitem")).toHaveCount(0);
});

test("counts the tasks it creates", async ({ page, request }) => {
  await page.goto("/");
  const before = await page.getByRole("listitem").count();

  const created = await request.post("/api/tasks", { data: { title: "Count me" } });
  await page.reload();
  await expect(page.getByRole("listitem")).toHaveCount(before + 1);

  await request.delete(`/api/tasks/${(await created.json()).id as number}`);
  await page.reload();
  await expect(page.getByRole("listitem")).toHaveCount(before);
});
