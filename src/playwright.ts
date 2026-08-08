import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

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
  /** Results in declaration order, one entry per test. */
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

/** The subset of Playwright the leak finder needs, kept small for testability. */
export interface TestRunner {
  list(passthroughArgs?: string[]): Promise<TestItem[]>;
  run(options?: RunOptions): Promise<RunOutcome>;
}

/**
 * Runs `playwright test` as a child process and reads back its JSON report.
 *
 * Tests always run with a single worker so that execution order matches
 * declaration order — a prerequisite for bisecting leaked state.
 */
export class PlaywrightRunner implements TestRunner {
  private readonly cwd: string;
  private cliPath: string | undefined;

  constructor(options: { cwd?: string } = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
  }

  async list(passthroughArgs: string[] = []): Promise<TestItem[]> {
    assertUsableArgs(passthroughArgs);
    const { specs } = await this.execute(["--list", ...passthroughArgs], {
      quiet: true,
    });
    return specs.map(({ id, file, line }) => ({ id, file, line }));
  }

  async run(options: RunOptions = {}): Promise<RunOutcome> {
    assertUsableArgs(options.passthroughArgs ?? []);
    const args = [
      "--workers=1",
      ...(options.stopOnFirstFailure ? ["--max-failures=1"] : []),
      ...(options.locations ?? []).map(locationArg),
      ...(options.passthroughArgs ?? []),
    ];
    const { specs, exitCode } = await this.execute(args, {
      quiet: options.quiet ?? false,
    });
    return {
      exitCode,
      results: specs.map(({ id, file, line, status }) => ({ id, file, line, status })),
    };
  }

  private async execute(
    args: string[],
    { quiet }: { quiet: boolean },
  ): Promise<{ specs: FlatSpec[]; exitCode: number }> {
    const outputDir = await mkdtemp(
      path.join(os.tmpdir(), "playwright-leak-finder-"),
    );
    const outputFile = path.join(outputDir, "report.json");
    try {
      const exitCode = await this.spawnPlaywright(
        ["test", `--reporter=${quiet ? "json" : "list,json"}`, ...args],
        outputFile,
        quiet,
      );
      const report = await readReport(outputFile, exitCode);
      const projects = selectedProjects(args);
      const specs = flattenSpecs(report, projects);
      const dependencyFailures = failuresOutsideProjects(report, projects);
      if (dependencyFailures.length > 0) {
        throw new Error(
          "A Playwright dependency project failed before the selected project could run:\n" +
            dependencyFailures.map((failure) => `  ${failure}`).join("\n"),
        );
      }
      assertSingleProject(specs);
      return { specs, exitCode };
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }

  private spawnPlaywright(
    args: string[],
    jsonOutputFile: string,
    quiet: boolean,
  ): Promise<number> {
    const cli = this.resolveCli();
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd: this.cwd,
        stdio: ["ignore", quiet ? "ignore" : "inherit", "inherit"],
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOutputFile },
      });
      // Without this a SIGTERM leaves `playwright test` — and its browsers —
      // running, and skips the temp-report cleanup in execute()'s finally.
      const stop = (): void => {
        child.kill();
      };
      process.once("SIGINT", stop).once("SIGTERM", stop);
      child.on("error", reject);
      child.on("close", (code) => {
        process.off("SIGINT", stop).off("SIGTERM", stop);
        resolve(code ?? 1);
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
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("[/\\\\]");
  return `/[/\\\\]${pattern}$/:${line}`;
}

/**
 * Flags the search sets itself, or that break its premises. Playwright's
 * parser lets the last occurrence win, so a forwarded copy would silently
 * take over: `--workers=2` breaks declaration order, `--reporter=list`
 * suppresses the JSON report, `--retries` turns a failure into a `flaky`
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

async function readReport(file: string, exitCode: number): Promise<JsonReport> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as JsonReport;
  } catch (cause) {
    throw new Error(
      `Playwright exited with code ${exitCode} without producing a JSON report`,
      { cause },
    );
  }
}

// Minimal shape of Playwright's JSON reporter output.
interface JsonReport {
  suites?: JsonSuite[];
}

interface JsonSuite {
  title: string;
  suites?: JsonSuite[];
  specs?: JsonSpec[];
}

interface JsonSpec {
  title: string;
  file: string;
  line: number;
  tests?: Array<{ status?: string; projectName?: string }>;
}

interface FlatSpec extends TestItem {
  status: TestStatus;
  projects: string[];
}

/**
 * A run covering several projects repeats every spec once per project, so
 * there is no single declaration order to bisect and ids are ambiguous.
 * Refuse rather than search a suite whose ordering premise does not hold.
 */
function assertSingleProject(specs: FlatSpec[]): void {
  const projects = new Set(specs.flatMap((spec) => spec.projects));
  if (projects.size > 1) {
    throw new Error(
      `This run covers ${projects.size} Playwright projects ` +
        `(${[...projects].join(", ")}), so every test runs more than once and ` +
        "there is no single order to bisect. Re-run with --project=<name>.",
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
  const names: string[] = [];
  let readsProjectNames = false;
  for (const arg of args) {
    if (arg === "--project") {
      readsProjectNames = true;
    } else if (arg.startsWith("--project=")) {
      names.push(arg.slice("--project=".length));
      readsProjectNames = false;
    } else if (arg.startsWith("-")) {
      readsProjectNames = false;
    } else if (readsProjectNames) {
      names.push(arg);
    }
  }
  if (names.length === 0) {
    return undefined;
  }
  return names.map(projectPattern);
}

function projectPattern(name: string): RegExp {
  const pattern = name
    .split("*")
    .map(escapeRegex)
    .join(".*");
  return new RegExp(`^${pattern}$`, "u");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function failuresOutsideProjects(
  report: JsonReport,
  selected: readonly RegExp[] | undefined,
): string[] {
  if (selected === undefined) {
    return [];
  }
  const projectNames = new Set(
    flattenSpecs(report).flatMap((spec) => spec.projects),
  );
  return [...projectNames]
    .filter((name) => !selected.some((pattern) => pattern.test(name)))
    .flatMap((name) =>
      flattenSpecs(report, [new RegExp(`^${escapeRegex(name)}$`, "u")])
        .filter((spec) => spec.status === "failed")
        .map((spec) => `[${name}] ${spec.id}`),
    );
}

function flattenSpecs(
  report: JsonReport,
  projects?: readonly RegExp[],
): FlatSpec[] {
  // Top-level suites represent files; nested suites are describe blocks.
  // The report keeps a suite's own specs and its describe blocks in separate
  // arrays, losing their interleaving, so sort by line to recover declaration
  // order — which is the execution order the whole search depends on.
  return (report.suites ?? []).flatMap((fileSuite) =>
    specsOf(fileSuite, [], projects).sort((a, b) => a.line - b.line),
  );
}

function specsOf(
  suite: JsonSuite,
  describePath: string[],
  projects?: readonly RegExp[],
): FlatSpec[] {
  const own = (suite.specs ?? []).flatMap((spec) => {
    const flattened = toFlatSpec(spec, describePath, projects);
    return flattened === null ? [] : [flattened];
  });
  const nested = (suite.suites ?? []).flatMap((child) =>
    specsOf(child, [...describePath, child.title], projects),
  );
  return [...own, ...nested];
}

function toFlatSpec(
  spec: JsonSpec,
  describePath: string[],
  projects?: readonly RegExp[],
): FlatSpec | null {
  const tests = (spec.tests ?? []).filter(
    (test) =>
      projects === undefined ||
      projects.some((pattern) => pattern.test(test.projectName ?? "")),
  );
  if (projects !== undefined && tests.length === 0) {
    return null;
  }
  return {
    id: `${spec.file} › ${[...describePath, spec.title].join(" › ")}`,
    file: spec.file,
    line: spec.line,
    status: specStatus({ ...spec, tests }),
    projects: tests.map((test) => test.projectName ?? ""),
  };
}

function specStatus(spec: JsonSpec): TestStatus {
  const statuses = (spec.tests ?? []).map((test) => test.status);
  // "flaky" means it failed at least once, so the leak did reproduce.
  if (statuses.some((status) => status === "unexpected" || status === "flaky")) {
    return "failed";
  }
  // An empty list means nothing ran, which the search treats as inconclusive.
  if (statuses.every((status) => status === "skipped")) {
    return "skipped";
  }
  // Multi-project configs report one entry per project, so a spec can be
  // "expected" in one and "skipped" in another. Any pass without a failure
  // is a pass.
  if (statuses.some((status) => status === "expected")) {
    return "passed";
  }
  // Never guess: an unknown status read as "passed" sends the search into the
  // wrong half and names an innocent test.
  throw new Error(
    `Unrecognised Playwright status for "${spec.title}": ${statuses.join(", ")}`,
  );
}
