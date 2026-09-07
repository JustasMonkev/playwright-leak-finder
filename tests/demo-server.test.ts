import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterAll, beforeAll, expect, it } from "vitest";

const server = spawn(process.execPath, ["demo/server.mjs"], {
  env: { ...process.env, PORT: "0" },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = once(server.stdout, "data");
let baseUrl: string;

beforeAll(async () => {
  const [output] = await ready;
  const address = String(output).match(/http:\/\/localhost:\d+/u)?.[0];
  if (!address) throw new Error(`Missing demo server address: ${output}`);
  baseUrl = address;
});

afterAll(async () => {
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
});

it("rejects malformed JSON without creating or changing tasks", async () => {
  const created = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    body: JSON.stringify({ title: "Keep me" }),
  });
  expect(created.status).toBe(201);
  const task = await created.json();
  if (typeof task !== "object" || task === null || !("id" in task)) {
    throw new Error("The demo server did not return a task id");
  }
  const taskUrl = `${baseUrl}/api/tasks/${task.id}`;
  expect((await fetch(taskUrl, { method: "PATCH", body: '{"done":true}' })).status).toBe(200);

  for (const [url, method] of [[taskUrl, "PATCH"], [`${baseUrl}/api/tasks`, "POST"]] as const) {
    const rejected = await fetch(url, { method, body: "{broken" });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "Invalid JSON" });
  }
  expect(await (await fetch(`${baseUrl}/api/tasks`)).json()).toEqual([
    { id: task.id, title: "Keep me", done: true },
  ]);
});
