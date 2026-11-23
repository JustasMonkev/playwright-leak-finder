import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { FullConfig, Reporter, Suite, TestCase } from "@playwright/test/reporter";
import type { TestResult, TestStatus } from "./playwright";

export interface ProjectReport {
  name: string;
  results: TestResult[];
  scheduled: boolean;
}

const statuses: Record<ReturnType<TestCase["outcome"]>, TestStatus> = {
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
    // Differently configured projects may also have the same (or empty) name.
    this.mayRepeat = config.projects.some((project) => project.repeatEach > 1)
      || new Set(config.projects.map((project) => project.name)).size < config.projects.length;
    this.collected = suite.allTests();
  }

  onTestBegin(test: TestCase): void {
    this.started.add(test);
  }

  printsToStdio(): boolean {
    return false;
  }

  async onEnd(): Promise<void> {
    // Start events give the true run order, even across worker groups.
    // Unstarted cases (all cases during --list) retain collection order.
    for (const test of this.collected) this.started.add(test);
    const projects = new Map<string, ProjectReport>();
    const repeated = new Map<string, TestResult>();
    for (const test of this.started) {
      const name = test.parent.project()?.name ?? "";
      let report = projects.get(name);
      if (!report) {
        report = { name, scheduled: false, results: [] };
        projects.set(name, report);
      }
      report.scheduled ||= test.results.length > 0;
      const result = this.result(test);
      if (this.mayRepeat) {
        // The display ID flattens title components with " › ", which is also
        // legal in titles. Use the structured path to identify a declaration.
        const { file, line, column } = test.location;
        const key = JSON.stringify([test.titlePath(), file, line, column]);
        const previous = repeated.get(key);
        if (previous) {
          if (result.status === "failed" || previous.status === "skipped") {
            previous.status = result.status;
          }
          continue;
        }
        repeated.set(key, result);
      }
      report.results.push(result);
    }
    await writeFile(process.env.PLAYWRIGHT_LEAK_FINDER_REPORT!, JSON.stringify([...projects.values()]));
  }

  private result(test: TestCase): TestResult {
    const file = path.relative(this.rootDir, test.location.file).split(path.sep).join("/");
    // titlePath() omits anonymous describes. Keep their empty component so
    // IDs still match snapshots written by the former JSON adapter.
    const titles = [test.title];
    for (let suite = test.parent; suite.parent?.location; suite = suite.parent) {
      titles.push(suite.title);
    }
    return {
      id: [file, ...titles.reverse()].join(" › "),
      file,
      line: test.location.line,
      status: statuses[test.outcome()],
    };
  }
}
