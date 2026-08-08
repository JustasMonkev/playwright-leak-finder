import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const cli = path.join(repoRoot, "dist", "cli.mjs");

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function waitForStart(child: ChildProcess, output: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for Playwright to start:\n${output()}`));
    }, 15_000);
    const check = (): void => {
      if (/Running 1 test/u.test(output())) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout?.on("data", check);
    child.once("close", () => {
      clearTimeout(timeout);
      reject(new Error(`CLI exited before Playwright started:\n${output()}`));
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

      await waitForStart(child, () => `${stdout}${stderr}`);
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
});
