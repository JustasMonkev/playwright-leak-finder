import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectReport } from "./playwright-report";

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
    const passthroughArgs = options.passthroughArgs ?? [];
    const args = ["--workers=1"];
    if (options.stopOnFirstFailure) args.push("--max-failures=1");
    for (const location of options.locations ?? []) args.push(locationArg(location));
    return this.execute(args, passthroughArgs, options.quiet ?? false);
  }

  private async execute(
    controlledArgs: readonly string[],
    passthroughArgs: readonly string[],
    quiet: boolean,
  ): Promise<RunOutcome> {
    assertUsableArgs(passthroughArgs);
    const projects = selectedProjects(passthroughArgs);
    const outputDir = await mkdtemp(
      path.join(os.tmpdir(), "playwright-leak-finder-"),
    );
    const outputFile = path.join(outputDir, "report.json");
    try {
      // Use the sibling .ts in source checkouts and .mjs in the installed build.
      const moduleFile = fileURLToPath(import.meta.url);
      const extension = path.extname(moduleFile);
      const reporter = path.join(path.dirname(moduleFile), `playwright-report${extension}`);
      const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_LEAK_FINDER_REPORT: outputFile };
      let reporterArg = reporter.includes(",") ? path.relative(this.cwd, reporter) : reporter;
      if (reporterArg.includes(",")) {
        // Playwright splits --reporter on commas without escaping. For an
        // unrelated consumer cwd, resolve a private copy by module name.
        reporterArg = path.basename(outputDir) + extension;
        await copyFile(reporter, path.join(outputDir, reporterArg));
        env.NODE_PATH = [outputDir, env.NODE_PATH].filter(Boolean).join(path.delimiter);
      }
      const args = [
        "test",
        `--reporter=${quiet ? "" : "list,"}${reporterArg}`,
        ...controlledArgs,
        ...passthroughArgs,
      ];
      const outcome = await this.spawnPlaywright(args, env, quiet);
      // Programmatic consumers may have their own signal handler. Reject once
      // cleanup has run; only the CLI layer translates this back into process
      // termination, so library use never re-dispatches a consumer's signal.
      if (outcome.forwardedSignal !== undefined) {
        throw new PlaywrightInterruptedError(outcome.forwardedSignal);
      }
      const { exitCode } = outcome;
      const results = await readReport(outputFile, exitCode, projects);
      return { exitCode, results };
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }

  private spawnPlaywright(
    args: string[],
    env: NodeJS.ProcessEnv,
    quiet: boolean,
  ): Promise<{ exitCode: number; forwardedSignal?: NodeJS.Signals }> {
    const cli = this.resolveCli();
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd: this.cwd,
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
        if (forwardedSignal === undefined) {
          forwardedSignal = signal;
          child.kill(signal);
          // A child that ignores a signal must not make the parent CLI hang
          // forever. Give Playwright time to close browsers cleanly first.
          forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
          forceKill.unref();
        }
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
          forwardedSignal === undefined
            ? { exitCode: code ?? 1 }
            : { exitCode: code ?? 1, forwardedSignal },
        );
      });
    });
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

/**
 * Formats a `file:line` filter for `playwright test`. A bare file argument is
 * treated as an unanchored, case-insensitive regex over the absolute test file
 * path, so `nav.spec.ts:3` would also select `main-nav.spec.ts:3` and dots
 * match anything. A `/.../`-wrapped argument is used as an explicit regex
 * instead, so emit one: escaped, and anchored to a path separator and the end
 * of the path. `file` is relative to Playwright's rootDir and can start with
 * `..` (a project testDir outside it); those segments cannot appear in the
 * resolved absolute path, so anchor from the first real segment.
 * ponytail: a file at another root that ends with the same segments would
 * still match; the ran-vs-selected guard turns that into an inconclusive step
 * rather than a wrong answer. Anchoring on rootDir-resolved absolute paths is
 * the upgrade if it bites.
 */
function locationArg({ file, line }: { file: string; line: number }): string {
  const segments = file.split(/[/\\]/u);
  while (segments[0] === "..") {
    segments.shift();
  }
  const pattern = segments
    .map(escapeRegex)
    .join("[/\\\\]");
  return `/[/\\\\]${pattern}$/:${line}`;
}

/**
 * Flags the search sets itself, or that break its premises. Playwright's
 * parser lets the last occurrence win, so a forwarded copy would silently
 * take over: `--workers=2` allows tests to overlap, `--reporter=list`
 * suppresses the leak finder report, `--retries` turns a failure into a `flaky`
 * pass, `--shard`/`--repeat-each` change which tests run and under which id,
 * `--last-failed` changes between search steps, and interactive UI/debug
 * options never produce a usable report.
 */
const RESERVED_ARGS = [
  "--reporter",
  "--workers",
  "-j",
  "--max-failures",
  "-x",
  "--list",
  "--retries",
  "--shard",
  "--repeat-each",
  "--last-failed",
  "--last-failed-file",
  "--ui",
  "--ui-host",
  "--ui-port",
  "--debug",
] as const;

/**
 * Playwright options that may consume the following token as their value.
 * Keep this in sync with the `playwright test --help` option grammar. Boolean
 * flags must not appear here: otherwise a positional test filter immediately
 * after one (for example `--headed demo.spec.ts`) would evade validation and
 * widen every bisection run.
 */
const VALUE_TAKING_ARGS = new Set([
  "--add-reporter",
  "--browser",
  "-c",
  "--config",
  "--global-timeout",
  "-g",
  "--grep",
  "-G",
  "--grep-invert",
  "--only-changed",
  "--output",
  "--project",
  "--run-agents",
  "--test-list",
  "--test-list-invert",
  "--timeout",
  "--trace",
  "--tsconfig",
  "-u",
  "--update-snapshots",
  "--update-source-method",
]);

function assertUsableArgs(args: readonly string[]): void {
  const reserved = args.find((arg) =>
    // Short flags carry their value attached (`-j2`) or clustered (`-xj2`).
    RESERVED_ARGS.some((flag) =>
      flag.length === 2
        ? arg.startsWith(flag)
        : arg === flag || arg.startsWith(`${flag}=`),
    ),
  );
  if (reserved !== undefined) {
    throw new Error(
      `Cannot forward ${reserved} to \`playwright test\`: the leak finder ` +
        `controls ${RESERVED_ARGS.join(", ")} itself, and overriding them ` +
        "would break the search. Remove it from your arguments.",
    );
  }

  // Positional test filters are OR'd with the `file:line` filters the search
  // uses, so one would widen every step back to the whole file and pin the
  // leak on an innocent test. --config/--project/--grep narrow, and are fine.
  let remainingValues = 0;
  const positional = args.find((arg) => {
    if (arg.startsWith("-")) {
      remainingValues =
        arg === "--project"
          ? Number.POSITIVE_INFINITY
          : VALUE_TAKING_ARGS.has(arg)
            ? 1
            : 0;
      return false;
    }
    if (remainingValues > 0) {
      remainingValues -= 1;
      return false;
    }
    return true;
  });
  if (positional !== undefined) {
    throw new Error(
      `Cannot forward the test filter "${positional}" to \`playwright test\`: ` +
        "it would be combined with the filters the search uses, widening " +
        "every step instead of narrowing it. Use --grep or --project instead.",
    );
  }
}

/**
 * Returns the projects explicitly requested on the command line. Playwright
 * also reports setup/dependency projects when one project is selected; those
 * projects must execute, but their results are not part of the suite being
 * bisected.
 */
function selectedProjects(args: readonly string[]): RegExp[] | undefined {
  const patterns: RegExp[] = [];
  let readsProjectNames = false;
  for (const arg of args) {
    if (arg === "--project") {
      readsProjectNames = true;
    } else if (arg.startsWith("--project=")) {
      patterns.push(projectPattern(arg.slice("--project=".length)));
      readsProjectNames = false;
    } else if (arg.startsWith("-")) {
      readsProjectNames = false;
    } else if (readsProjectNames) {
      patterns.push(projectPattern(arg));
    }
  }
  return patterns.length ? patterns : undefined;
}

function projectPattern(name: string): RegExp {
  const pattern = name
    .split("*")
    .map(escapeRegex)
    .join(".*");
  // Playwright matches --project names case-insensitively. Mirror that when
  // filtering its report so selected tests do not disappear after the
  // CLI accepted the user's spelling.
  return new RegExp(`^${pattern}$`, "iu");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function readReport(
  file: string,
  exitCode: number,
  projects: readonly RegExp[] | undefined,
): Promise<TestResult[]> {
  let reports: ProjectReport[];
  try {
    // The child writes this private file using the same ProjectReport contract.
    reports = JSON.parse(await readFile(file, "utf8")) as ProjectReport[];
  } catch (cause) {
    throw new Error(
      `Playwright exited with code ${exitCode} without producing a JSON report`,
      { cause },
    );
  }

  const selected = reports.filter(({ name }) =>
    !projects || projects.some((pattern) => pattern.test(name)),
  );
  // A failed setup can prevent every selected test from running. If even
  // a deliberately skipped test was scheduled, the failure may be a teardown.
  if (selected.length < reports.length && !selected.some((report) => report.scheduled)) {
    const failures: string[] = [];
    for (const report of reports) {
      if (selected.includes(report)) continue;
      for (const test of report.results) {
        if (test.status === "failed") failures.push(`  [${report.name}] ${test.id}`);
      }
    }
    if (failures.length) {
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
