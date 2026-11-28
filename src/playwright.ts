import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRunArgs, parseProjectFilters } from "./playwright-options";
import type { ProjectReport, RunReport } from "./playwright-report";

export interface TestItem {
  /** Stable id: relative file path plus the full title path. */
  id: string;
  file: string;
  line: number;
}

export type TestStatus = "passed" | "failed" | "skipped";

export interface TestResult {
  id: string;
  file: string;
  line: number;
  status: TestStatus;
}

export interface RunOutcome {
  exitCode: number;
  /** One verdict per declaration in first-start order; unstarted tests follow in collection order. */
  results: TestResult[];
}

export interface RunOptions {
  /** Filters restricting which tests run; omit to run everything. */
  locations?: Array<{ file: string; line: number }>;
  stopOnFirstFailure?: boolean;
  /** Extra arguments forwarded to `playwright test` (e.g. `--config`). */
  passthroughArgs?: string[];
  /** Hide Playwright's own output, for runs the user did not ask to see. */
  quiet?: boolean;
}

/** The Playwright child was stopped because this process received a signal. */
export class PlaywrightInterruptedError extends Error {
  readonly signal: NodeJS.Signals;

  constructor(signal: NodeJS.Signals) {
    super(`Playwright was interrupted by ${signal}`);
    this.name = "PlaywrightInterruptedError";
    this.signal = signal;
  }
}

/** The subset of Playwright the leak finder needs, kept small for testability. */
export interface TestRunner {
  list(passthroughArgs?: string[]): Promise<TestItem[]>;
  run(options?: RunOptions): Promise<RunOutcome>;
}

/**
 * Runs `playwright test` as a child process and reads back its test verdicts.
 *
 * Tests always run with a single worker so that execution order is observable.
 */
export class PlaywrightRunner implements TestRunner {
  private readonly cwd: string;
  private cliPath: string | undefined;

  constructor(options: { cwd?: string } = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
  }

  async list(passthroughArgs: string[] = []): Promise<TestItem[]> {
    const { results } = await this.execute(["--list"], passthroughArgs, true);
    return results.map(({ id, file, line }) => ({ id, file, line }));
  }

  async run(options: RunOptions = {}): Promise<RunOutcome> {
    return this.execute(
      buildRunArgs(options),
      options.passthroughArgs ?? [],
      options.quiet ?? false,
    );
  }

  private async execute(
    controlledArgs: readonly string[],
    passthroughArgs: readonly string[],
    quiet: boolean,
  ): Promise<RunOutcome> {
    const projectFilters = parseProjectFilters(passthroughArgs);
    const outputDir = await mkdtemp(
      path.join(os.tmpdir(), "playwright-leak-finder-"),
    );
    const outputFile = path.join(outputDir, "report.json");
    try {
      const { reporterArg, env } = await prepareReporter(this.cwd, outputFile);
      const args = [
        "test",
        // An empty selection is a search outcome, not a Playwright run error.
        "--pass-with-no-tests",
        `--reporter=${quiet ? "" : "list,"}${reporterArg}`,
        ...controlledArgs,
        ...passthroughArgs,
      ];
      const outcome = await spawnPlaywright(this.resolveCli(), args, {
        cwd: this.cwd,
        env,
        quiet,
      });
      if (outcome.interrupted) {
        throw new PlaywrightInterruptedError(outcome.signal);
      }
      const results = await readReport(outputFile, outcome.exitCode, projectFilters);
      return { exitCode: outcome.exitCode, results };
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }

  private resolveCli(): string {
    if (this.cliPath === undefined) {
      const require = createRequire(path.join(this.cwd, "package.json"));
      try {
        this.cliPath = require.resolve("@playwright/test/cli");
      } catch {
        throw new Error(
          `Could not resolve @playwright/test from ${this.cwd}. ` +
            "Install it in your project before running the leak finder.",
        );
      }
    }
    return this.cliPath;
  }
}

interface PreparedReporter {
  reporterArg: string;
  env: NodeJS.ProcessEnv;
}

async function prepareReporter(
  cwd: string,
  outputFile: string,
): Promise<PreparedReporter> {
  // Use the sibling .ts in source checkouts and .mjs in the installed build.
  const moduleFile = fileURLToPath(import.meta.url);
  const extension = path.extname(moduleFile);
  const reporterPath = path.join(path.dirname(moduleFile), `playwright-report${extension}`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLAYWRIGHT_LEAK_FINDER_REPORT: outputFile,
  };

  // Playwright splits --reporter on commas. Prefer the relative path if it
  // avoids the comma; otherwise load a private copy by module name.
  let reporterArg = reporterPath.includes(",")
    ? path.relative(cwd, reporterPath)
    : reporterPath;
  if (reporterArg.includes(",")) {
    const outputDir = path.dirname(outputFile);
    reporterArg = path.basename(outputDir) + extension;
    await copyFile(reporterPath, path.join(outputDir, reporterArg));
    env.NODE_PATH = [outputDir, env.NODE_PATH].filter(Boolean).join(path.delimiter);
  }
  return { reporterArg, env };
}

const FORCE_KILL_DELAY_MS = 5_000;

interface SpawnPlaywrightOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  quiet: boolean;
}

type ProcessOutcome =
  | { interrupted: true; signal: NodeJS.Signals }
  | { interrupted: false; exitCode: number };

function spawnPlaywright(
  cli: string,
  args: readonly string[],
  { cwd, env, quiet }: SpawnPlaywrightOptions,
): Promise<ProcessOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      stdio: ["ignore", quiet ? "ignore" : "inherit", "inherit"],
      env,
    });
    // Without this a terminating signal leaves `playwright test` — and its
    // browsers — running, and skips the temp-report cleanup in execute()'s
    // finally. Return the signal after the child exits; the CLI re-raises it,
    // while programmatic consumers receive a typed interruption error.
    let forwardedSignal: NodeJS.Signals | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    const forwardSignal = (signal: NodeJS.Signals): void => {
      if (forwardedSignal !== undefined) return;
      forwardedSignal = signal;
      child.kill(signal);
      // A child that ignores a signal must not make the parent CLI hang
      // forever. Give Playwright time to close browsers cleanly first.
      forceKill = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
      forceKill.unref();
    };
    const cleanupSignalHandlers = (): void => {
      process.off("SIGINT", forwardSignal).off("SIGTERM", forwardSignal);
      if (forceKill !== undefined) {
        clearTimeout(forceKill);
      }
    };
    process.once("SIGINT", forwardSignal).once("SIGTERM", forwardSignal);
    child.on("error", (error) => {
      cleanupSignalHandlers();
      reject(error);
    });
    child.on("close", (code) => {
      cleanupSignalHandlers();
      resolve(
        forwardedSignal !== undefined
          ? { interrupted: true, signal: forwardedSignal }
          : { interrupted: false, exitCode: code ?? 1 },
      );
    });
  });
}

async function readReport(
  file: string,
  exitCode: number,
  projectFilters: readonly RegExp[],
): Promise<TestResult[]> {
  let run: RunReport;
  try {
    // The parent and its private reporter ship together.
    run = JSON.parse(await readFile(file, "utf8")) as RunReport;
  } catch (cause) {
    throw new Error(
      `Playwright exited with code ${exitCode} without producing a JSON report`,
      { cause },
    );
  }

  // Check all projects before filtering: a failed dependency teardown can
  // explain the exit code without invalidating the selected tests' verdicts.
  if (exitCode !== 0 && !run.projects.some((project) =>
    project.results.some((test) => test.status === "failed"),
  )) {
    throw new Error(
      `Playwright exited with code ${exitCode} without a failing test.` +
        (run.firstError ? `\n${run.firstError}` : ""),
    );
  }

  const selected: ProjectReport[] = [];
  const dependencies: ProjectReport[] = [];
  for (const report of run.projects) {
    if (projectFilters.length === 0 || projectFilters.some((pattern) => pattern.test(report.name))) {
      selected.push(report);
    } else {
      dependencies.push(report);
    }
  }

  // A failed setup can prevent every selected test from running. If even
  // a deliberately skipped test was scheduled, the failure may be a teardown.
  if (dependencies.length > 0 && !selected.some((report) => report.scheduled)) {
    const failures: string[] = [];
    for (const project of dependencies) {
      for (const test of project.results) {
        if (test.status === "failed") failures.push(`  [${project.name}] ${test.id}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        "A Playwright dependency project failed before the selected project could run:\n" +
          failures.join("\n"),
      );
    }
  }

  if (selected.length > 1) {
    throw new Error(
      `This run covers ${selected.length} Playwright projects ` +
        `(${selected.map((project) => project.name).join(", ")}), so every test runs more than once and ` +
        "there is no single order to bisect. Re-run with --project=<name>.",
    );
  }
  return selected[0]?.results ?? [];
}
