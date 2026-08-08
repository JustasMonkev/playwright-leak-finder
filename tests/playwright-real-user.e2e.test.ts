import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const fixture = path.join(repoRoot, "tests", "fixtures", "packed-consumer");

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function command(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("packed package in a real Playwright consumer", () => {
  let workDir: string;
  let consumerDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(repoRoot, "tests", ".tmp-packed-consumer-"));
    consumerDir = path.join(workDir, "consumer");
    const packageDir = path.join(workDir, "package");
    const npmEnv = { ...process.env, npm_config_cache: path.join(workDir, "npm-cache") };

    await mkdir(packageDir);
    for (const entry of ["dist", "LICENSE", "package.json", "README.md"]) {
      await cp(path.join(repoRoot, entry), path.join(packageDir, entry), {
        recursive: true,
      });
    }
    expect(
      (
        await command(
          "npm",
          ["pack", "--ignore-scripts", "--pack-destination", workDir],
          packageDir,
          npmEnv,
        )
      ).code,
    ).toBe(0);
    const tarball = path.join(
      workDir,
      (await readdir(workDir)).find((entry) => entry.endsWith(".tgz"))!,
    );
    await cp(fixture, consumerDir, { recursive: true });

    // This is intentionally a clean consumer. `--legacy-peer-deps` prevents
    // npm from fetching the peer dependency; Node resolves the repository's
    // installed @playwright/test as it would from a workspace consumer.
    expect(
      (
        await command(
          "npm",
          [
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--offline",
            "--legacy-peer-deps",
            tarball,
          ],
          consumerDir,
          npmEnv,
        )
      ).code,
    ).toBe(0);
  }, 180_000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const runLeakFinder = (...args: string[]) =>
    command(process.execPath, [path.join("node_modules", ".bin", "playwright-leak-finder"), ...args], consumerDir);

  // The packaged CLI persists every hunt. A person would reset before starting
  // another, unrelated investigation; do the same for independent scenarios.
  beforeEach(async () => {
    expect((await runLeakFinder("--reset")).code).toBe(0);
  });

  it("finds a nested serial leak while forwarding config, project, and grep", { timeout: 180_000 }, async () => {
    const result = await runLeakFinder(
      "--auto",
      "--config",
      "playwright.config.ts",
      "--project",
      "isol*",
      "--grep",
      "serial user workflow",
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("We found a leak!");
    expect(result.stdout).toContain(
      "Leak found in: isolated.spec.ts › serial user workflow › nested flow › leaks selected state",
    );
  });

  it("uses exact source locations after collection from the installed API", { timeout: 120_000 }, async () => {
    const script = [
      'import { PlaywrightRunner } from "playwright-leak-finder";',
      "const runner = new PlaywrightRunner();",
      'const args = ["--config", "playwright.config.ts", "--project", "isolated", "--grep", "serial user workflow"];',
      "const items = await runner.list(args);",
      'const selected = items.filter((item) => /leaks selected state|reports a clean state/.test(item.id));',
      "const outcome = await runner.run({ locations: selected, passthroughArgs: args, quiet: true });",
      "console.log(JSON.stringify({ items, outcome }));",
    ].join("\n");
    const result = await command(process.execPath, ["--input-type=module", "--eval", script], consumerDir);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      items: Array<{ id: string; file: string; line: number }>;
      outcome: { results: Array<{ id: string; status: string }> };
    };
    expect(report.items.map((item) => item.id)).toContain(
      "isolated.spec.ts › serial user workflow › nested flow › leaks selected state",
    );
    expect(report.outcome.results).toEqual([
      {
        file: "isolated.spec.ts",
        id: "isolated.spec.ts › serial user workflow › nested flow › leaks selected state",
        line: 19,
        status: "passed",
      },
      {
        file: "isolated.spec.ts",
        id: "isolated.spec.ts › serial user workflow › nested flow › reports a clean state",
        line: 23,
        status: "failed",
      },
    ]);
  });

  it("supports an explicitly selected project that has a setup dependency", { timeout: 180_000 }, async () => {
    const result = await runLeakFinder(
      "--auto",
      "--config=playwright.config.ts",
      "--project=dependent",
    );

    // Dependency projects execute once to prepare the requested project; they
    // do not mean the requested tests themselves run in multiple projects.
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Leak found in: dependent.spec.ts › project with setup dependency › leaker");
  });

  it("surfaces a failing setup dependency as an error", { timeout: 120_000 }, async () => {
    const result = await runLeakFinder(
      "--config=playwright.config.ts",
      "--project=blocked",
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "A Playwright dependency project failed before the selected project could run",
    );
    expect(result.stderr).toContain(
      "[failing-setup] failing.setup.ts › fails to create the prerequisite",
    );
    expect(result.stdout).not.toContain("No test failed");
  });
});
