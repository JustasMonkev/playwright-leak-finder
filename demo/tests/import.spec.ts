import { expect, test } from "@playwright/test";

const BATCH = ["Import: budget", "Import: roadmap", "Import: retro"];

test("imports a batch of tasks", async ({ page, request }) => {
  for (const title of BATCH) {
    const response = await request.post("/api/tasks", { data: { title } });
    expect(response.status()).toBe(201);
  }

  await page.goto("/");
  for (const title of BATCH) {
    await expect(page.getByText(title)).toBeVisible();
  }

  // The leak: this test never deletes what it imported, so the tasks stay on
  // the board for every test that runs after it.
});

test("rejects a task without a title", async ({ request }) => {
  const response = await request.post("/api/tasks", { data: { title: "  " } });

  expect(response.status()).toBe(400);
  expect(await response.json()).toEqual({ error: "title is required" });
});
