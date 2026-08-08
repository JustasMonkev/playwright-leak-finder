import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const cli = path.join(repoRoot, "dist", "cli.mjs");

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function waitForOutput(
  child: ChildProcess,
  output: () => string,
  pattern: RegExp,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for subprocess output:\n${output()}`));
    }, 15_000);
    const check = (): void => {
      if (pattern.test(output())) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout?.on("data", check);
    child.once("close", () => {
      clearTimeout(timeout);
      reject(new Error(`Subprocess exited before expected output:\n${output()}`));
    });
    check();
  });
}

describe("CLI signal forwarding", () => {
  const cleanups: Array<() => Promise<void>> = [];
  const children: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it.each<NodeJS.Signals>(["SIGINT", "SIGTERM"])(
    "forwards %s and exits with the same signal without hanging",
    { timeout: 30_000 },
    async (signal) => {
      const cwd = await mkdtemp(path.join(repoRoot, "tests", ".tmp-signal-"));
      cleanups.push(() => rm(cwd, { recursive: true, force: true }));
      const tempDir = path.join(cwd, "tmp");
      await Promise.all([
        mkdir(tempDir),
        writeFile(path.join(cwd, "package.json"), '{ "type": "module" }\n'),
        writeFile(
          path.join(cwd, "playwright.config.ts"),
          'import { defineConfig } from "@playwright/test";\n' +
            'export default defineConfig({ testDir: "." });\n',
        ),
        writeFile(
          path.join(cwd, "hang.spec.ts"),
          'import { test } from "@playwright/test";\n' +
            'test("waits for a signal", async () => await new Promise(() => {}));\n',
        ),
      ]);

      const child = spawn(process.execPath, [cli, "--config=playwright.config.ts"], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TMPDIR: tempDir },
      });
      children.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const exited = new Promise<Exit>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, receivedSignal) =>
          resolve({ code, signal: receivedSignal, stdout, stderr }),
        );
      });

      await waitForOutput(child, () => `${stdout}${stderr}`, /Running 1 test/u);
      expect(child.pid).toBeTypeOf("number");
      process.kill(child.pid!, signal);

      await expect(exited).resolves.toMatchObject({ code: null, signal });
      expect(
        (await readdir(tempDir)).filter((entry) =>
          entry.startsWith("playwright-leak-finder-"),
        ),
      ).toEqual([]);
    },
  );

  it.each<NodeJS.Signals>(["SIGINT", "SIGTERM"])(
    "rejects programmatic use on %s without dispatching the consumer handler twice",
    { timeout: 30_000 },
    async (signal) => {
      const cwd = await mkdtemp(path.join(repoRoot, "tests", ".tmp-signal-api-"));
      cleanups.push(() => rm(cwd, { recursive: true, force: true }));
      const tempDir = path.join(cwd, "tmp");
      await Promise.all([
        mkdir(tempDir),
        writeFile(path.join(cwd, "package.json"), '{ "type": "module" }\n'),
        writeFile(
          path.join(cwd, "playwright.config.ts"),
          'import { defineConfig } from "@playwright/test";\n' +
            'export default defineConfig({ testDir: "." });\n',
        ),
        writeFile(
          path.join(cwd, "hang.spec.ts"),
          'import { test } from "@playwright/test";\n' +
            'test("waits for a signal", async () => await new Promise(() => {}));\n',
        ),
      ]);

      const packageUrl = pathToFileURL(path.join(repoRoot, "dist", "index.mjs")).href;
      const script = [
        `import { PlaywrightInterruptedError, PlaywrightRunner } from ${JSON.stringify(packageUrl)};`,
        "const signal = process.env.SIGNAL_UNDER_TEST;",
        "let handlerCalls = 0;",
        "process.on(signal, () => handlerCalls++);",
        'const running = new PlaywrightRunner().run({ passthroughArgs: ["--config=playwright.config.ts"], quiet: false });',
        "try {",
        "  const result = await running;",
        "  console.log(JSON.stringify({ handlerCalls, resolved: true, results: result.results }));",
        "} catch (error) {",
        "  console.log(JSON.stringify({",
        "    handlerCalls,",
        "    resolved: false,",
        "    interrupted: error instanceof PlaywrightInterruptedError,",
        "    signal: error instanceof PlaywrightInterruptedError ? error.signal : null,",
        "  }));",
        "}",
      ].join("\n");
      const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          SIGNAL_UNDER_TEST: signal,
          TMPDIR: tempDir,
        },
      });
      children.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const exited = new Promise<Exit>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, receivedSignal) =>
          resolve({ code, signal: receivedSignal, stdout, stderr }),
        );
      });

      // This comes from the actual Playwright child, so the runner has
      // completed mkdtemp(), spawned it, and installed signal forwarding.
      await waitForOutput(child, () => `${stdout}${stderr}`, /Running 1 test/u);
      process.kill(child.pid!, signal);
      const result = await exited;

      expect(result).toMatchObject({ code: 0, signal: null });
      const summary = result.stdout
        .trim()
        .split("\n")
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return null;
          }
        })
        .find((value) => value !== null);
      expect(summary).toEqual({
        handlerCalls: 1,
        resolved: false,
        interrupted: true,
        signal,
      });
      expect(
        (await readdir(tempDir)).filter((entry) =>
          entry.startsWith("playwright-leak-finder-"),
        ),
      ).toEqual([]);
    },
  );
});
