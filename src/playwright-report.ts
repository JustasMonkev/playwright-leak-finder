import { readFile } from "node:fs/promises";
import type { JSONReport, JSONReportSpec, JSONReportSuite, JSONReportTest } from "@playwright/test/reporter";
import type { TestResult, TestStatus } from "./playwright";

interface LocatedSpec {
  id: string;
  spec: JSONReportSpec;
}

export async function readReport(
  file: string,
  exitCode: number,
  projects: readonly RegExp[] | undefined,
): Promise<TestResult[]> {
  let report: JSONReport;
  try {
    report = JSON.parse(await readFile(file, "utf8")) as JSONReport;
  } catch (cause) {
    throw new Error(
      `Playwright exited with code ${exitCode} without producing a JSON report`,
      { cause },
    );
  }

  const results: TestResult[] = [];
  const selectedNames = new Set<string>();
  const excludedNames = new Set<string>();
  function matchesProject(test: JSONReportTest): boolean {
    const name = test.projectName ?? "";
    if (selectedNames.has(name)) return true;
    if (excludedNames.has(name)) return false;
    if (projects?.some((pattern) => pattern.test(name))) {
      selectedNames.add(name);
      return true;
    }
    excludedNames.add(name);
    return false;
  }

  // Keep only excluded specs that might explain why no selected test ran.
  const possibleDependencies: LocatedSpec[] = [];
  let scheduled = false;
  for (const suite of report.suites ?? []) {
    const entries: LocatedSpec[] = [];
    collectSpecs(suite, "", entries);
    // A file suite's own specs and its describe blocks are separate arrays.
    // Restore their interleaving without changing the order of the files.
    entries.sort((a, b) => a.spec.line - b.spec.line);
    for (const entry of entries) {
      const { spec, id } = entry;
      const tests = spec.tests ?? [];
      const selected = projects === undefined ? tests : tests.filter(matchesProject);
      if (projects !== undefined && !scheduled) {
        // Even an intentional skip has a result. Once any selected test was
        // scheduled, excluded failures may be teardowns, not blocking setups.
        if (selected.some((test) => test.results?.length)) {
          scheduled = true;
          possibleDependencies.length = 0;
        } else if (selected.length < tests.length) {
          possibleDependencies.push(entry);
        }
      }
      if (projects !== undefined && !selected.length) continue;
      if (projects === undefined) {
        for (const test of tests) selectedNames.add(test.projectName ?? "");
      }
      results.push({
        id,
        file: spec.file,
        line: spec.line,
        status: specStatus(spec.title, selected),
      });
    }
  }

  assertNoDependencyFailure(possibleDependencies, excludedNames);
  if (selectedNames.size > 1) {
    throw new Error(
      `This run covers ${selectedNames.size} Playwright projects ` +
        `(${[...selectedNames].join(", ")}), so every test runs more than once and ` +
        "there is no single order to bisect. Re-run with --project=<name>.",
    );
  }
  return results;
}

function collectSpecs(suite: JSONReportSuite, titlePrefix: string, entries: LocatedSpec[]): void {
  for (const spec of suite.specs ?? []) {
    entries.push({ id: `${spec.file} › ${titlePrefix}${spec.title}`, spec });
  }
  for (const child of suite.suites ?? []) {
    collectSpecs(child, `${titlePrefix}${child.title} › `, entries);
  }
}

function assertNoDependencyFailure(entries: LocatedSpec[], excludedNames: Set<string>): void {
  const failures = new Map<string, string[]>();
  for (const { id, spec } of entries) {
    // A spec can have several test entries for the same project. Classify
    // them together, just as we do for the selected spec.
    const byProject = new Map<string, JSONReportTest[]>();
    for (const test of spec.tests ?? []) {
      const name = test.projectName ?? "";
      if (!excludedNames.has(name)) continue;
      const tests = byProject.get(name);
      if (tests) tests.push(test);
      else byProject.set(name, [test]);
    }
    for (const [name, tests] of byProject) {
      if (specStatus(spec.title, tests) !== "failed") continue;
      const ids = failures.get(name);
      if (ids) ids.push(id);
      else failures.set(name, [id]);
    }
  }
  if (failures.size) {
    // Group diagnostics by project in report order, then by declaration line.
    const lines = [...excludedNames].flatMap((name) =>
      (failures.get(name) ?? []).map((id) => `  [${name}] ${id}`),
    );
    throw new Error(
      "A Playwright dependency project failed before the selected project could run:\n" +
        lines.join("\n"),
    );
  }
}

function specStatus(title: string, tests: readonly JSONReportTest[]): TestStatus {
  let passed = false;
  let unknown = false;
  for (const { status } of tests) {
    // "flaky" means it failed at least once, so the leak did reproduce.
    if (status === "unexpected" || status === "flaky") return "failed";
    if (status === "expected") passed = true;
    else if (status !== "skipped") unknown = true;
  }
  if (passed) return "passed";
  if (!unknown) return "skipped"; // Nothing ran, or all entries were skipped.
  throw new Error(
    `Unrecognised Playwright status for "${title}": ${tests.map((test) => test.status).join(", ")}`,
  );
}
