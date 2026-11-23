import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { createProject, repoRoot } from "./e2e-helpers";

async function interrupt(args: string[], signal: NodeJS.Signals) {
  const cwd = await createProject({
    "package.json": '{ "type": "module" }\n',
    "playwright.config.ts":
      'import { defineConfig } from "@playwright/test";\n' +
      'export default defineConfig({ testDir: "." });\n',
    "hang.spec.ts":
      'import { test } from "@playwright/test";\n' +
      'test("waits for a signal", async () => await new Promise(() => {}));\n',
  });
  const tempDir = path.join(cwd, "tmp");
  await mkdir(tempDir);
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TMPDIR: tempDir, SIGNAL_UNDER_TEST: signal },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, receivedSignal) => resolve({ code, signal: receivedSignal }));
  });
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  });

  // Playwright's own progress line means signal forwarding is installed.
  const lines = createInterface({ input: child.stdout, signal: AbortSignal.timeout(15_000) });
  let signaled = false;
  for await (const line of lines) {
    if (line.includes("Running 1 test")) {
      signaled = child.kill(signal);
      break;
    }
  }
  expect(signaled, `Could not signal the running test:\n${stdout}${stderr}`).toBe(true);
  const exit = await exited;
  const tempFiles = await readdir(tempDir);
  expect(tempFiles.filter((entry) => entry.startsWith("playwright-leak-finder-"))).toEqual([]);
  return { ...exit, stdout };
}

describe("CLI signal forwarding", () => {
  it.each<NodeJS.Signals>(["SIGINT", "SIGTERM"])(
    "forwards %s and exits with the same signal without hanging",
    { timeout: 30_000 },
    async (signal) => {
      const cli = path.join(repoRoot, "dist", "cli.mjs");
      const result = await interrupt([cli, "--config=playwright.config.ts"], signal);
      expect(result).toMatchObject({ code: null, signal });
    },
  );

  it.each<NodeJS.Signals>(["SIGINT", "SIGTERM"])(
    "rejects programmatic use on %s without dispatching the consumer handler twice",
    { timeout: 30_000 },
    async (signal) => {
      const packageUrl = pathToFileURL(path.join(repoRoot, "dist", "index.mjs")).href;
      const script = [
        `import { PlaywrightInterruptedError, PlaywrightRunner } from ${JSON.stringify(packageUrl)};`,
        "const signal = process.env.SIGNAL_UNDER_TEST;",
        "let handlerCalls = 0;",
        "process.on(signal, () => handlerCalls++);",
        "try {",
        '  await new PlaywrightRunner().run({ passthroughArgs: ["--config=playwright.config.ts"], quiet: false });',
        "} catch (error) {",
        "  console.log(JSON.stringify({",
        "    handlerCalls,",
        "    interrupted: error instanceof PlaywrightInterruptedError,",
        "    signal: error.signal,",
        "  }));",
        "}",
      ].join("\n");
      const result = await interrupt(["--input-type=module", "--eval", script], signal);

      expect(result).toMatchObject({ code: 0, signal: null });
      const lastLine = result.stdout.trim().split("\n").at(-1)!;
      expect(JSON.parse(lastLine)).toEqual({ handlerCalls: 1, interrupted: true, signal });
    },
  );
});
