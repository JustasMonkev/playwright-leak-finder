import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { FullConfig, Reporter, Suite, TestCase } from "@playwright/test/reporter";
import type { TestResult, TestStatus } from "./playwright";

export interface ProjectReport {
  name: string;
  results: TestResult[];
  scheduled: boolean;
}

const OUTCOME_STATUS: Record<ReturnType<TestCase["outcome"]>, TestStatus> = {
  expected: "passed",
  skipped: "skipped",
  unexpected: "failed",
  flaky: "failed", // A retry passed, but the leak did reproduce.
};

export default class LeakFinderReporter implements Reporter {
  private rootDir = "";
  private mayRepeat = false;
  private collected: TestCase[] = [];
  private readonly started = new Set<TestCase>();

  onBegin(config: FullConfig, suite: Suite): void {
    this.rootDir = config.rootDir;
    this.mayRepeat = mayEmitRepeatedDeclarations(config);
    this.collected = suite.allTests();
  }

  onTestBegin(test: TestCase): void {
    this.started.add(test);
  }

  printsToStdio(): boolean {
    return false;
  }

  async onEnd(): Promise<void> {
    // A Set retains first-start order. Tests that never started (all tests
    // during --list) follow in collection order.
    for (const test of this.collected) this.started.add(test);
    const reports = this.buildProjectReports(this.started);
    await writeFile(process.env.PLAYWRIGHT_LEAK_FINDER_REPORT!, JSON.stringify(reports));
  }

  private buildProjectReports(tests: Set<TestCase>): ProjectReport[] {
    const reportsByProject = new Map<string, ProjectReport>();
    const repeats = this.mayRepeat ? new Map<string, TestResult>() : undefined;
    for (const test of tests) {
      const report = getOrCreateProjectReport(reportsByProject, test.parent.project()?.name ?? "");
      // A skipped test can still distinguish a scheduled project from a blocked one.
      report.scheduled ||= test.results.length > 0;
      const result = this.toTestResult(test);
      if (repeats) {
        const key = declarationKey(test);
        const previous = repeats.get(key);
        if (previous) {
          previous.status = mergeRepeatedStatus(previous.status, result.status);
          continue;
        }
        repeats.set(key, result);
      }
      report.results.push(result);
    }

    return [...reportsByProject.values()];
  }

  private toTestResult(test: TestCase): TestResult {
    const file = path.relative(this.rootDir, test.location.file).split(path.sep).join("/");
    return {
      id: formatTestId(file, test),
      file,
      line: test.location.line,
      status: OUTCOME_STATUS[test.outcome()],
    };
  }
}

function mayEmitRepeatedDeclarations(config: FullConfig): boolean {
  if (config.projects.some((project) => project.repeatEach > 1)) return true;
  // Differently configured projects can share a name and thus a report.
  const names = new Set(config.projects.map((project) => project.name));
  return names.size < config.projects.length;
}

function getOrCreateProjectReport(
  reports: Map<string, ProjectReport>,
  name: string,
): ProjectReport {
  let report = reports.get(name);
  if (!report) {
    report = { name, scheduled: false, results: [] };
    reports.set(name, report);
  }
  return report;
}

function declarationKey(test: TestCase): string {
  // The display ID flattens title components with " › ", which is also legal
  // in titles. Key on the structured title path and source location instead.
  const { file, line, column } = test.location;
  return JSON.stringify([test.titlePath(), file, line, column]);
}

function mergeRepeatedStatus(previous: TestStatus, next: TestStatus): TestStatus {
  if (previous === "failed" || next === "failed") return "failed";
  if (previous === "passed" || next === "passed") return "passed";
  return "skipped";
}

function formatTestId(file: string, test: TestCase): string {
  // titlePath() omits anonymous describes. Walk ancestor describe suites so
  // empty titles keep their slot and match snapshots from the former JSON adapter.
  const titles = [test.title];
  for (let suite = test.parent; suite.parent?.location; suite = suite.parent) {
    titles.push(suite.title);
  }
  return [file, ...titles.reverse()].join(" › ");
}
