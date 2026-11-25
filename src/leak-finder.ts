import { selectPartition, suspectRange, type SuspectRange } from "./bizect";
import type { TestResult, TestRunner } from "./playwright";
import type { LeakFinderState, StateStore, SuiteItem } from "./state";

export interface LeakFinderReport {
  /** True when running again would not advance the search. */
  done: boolean;
  /** Human-readable summary lines. */
  lines: string[];
  /** The test identified as leaking, once the search has converged. */
  leakCandidate: string | null;
}

/**
 * Binary-searches previously passing tests to find the one that leaks
 * state into a later, failing test (the "target").
 *
 * Each `run()` performs one step of the search and persists progress, so
 * repeated CLI invocations converge on the culprit — in the spirit of
 * `git bisect`.
 */
export class LeakFinder {
  constructor(
    private readonly runner: TestRunner,
    private readonly store: StateStore,
  ) {}

  async run(passthroughArgs: string[] = []): Promise<LeakFinderReport> {
    const state = await this.store.load();
    if (state.target === null) {
      return this.captureTarget(passthroughArgs);
    }
    return this.bisect(state, passthroughArgs);
  }

  /** First run: execute the suite until something fails and remember it. */
  private async captureTarget(args: string[]): Promise<LeakFinderReport> {
    const { results } = await this.runner.run({
      stopOnFirstFailure: true,
      passthroughArgs: args,
    });
    if (results.length === 0) {
      return done([
        "No tests were collected, so there is nothing to bisect.",
        "Check the config, project and filters you forwarded to `playwright test`.",
      ]);
    }

    const failureIndex = results.findIndex((result) => result.status === "failed");
    const failure = results[failureIndex];
    if (!failure) {
      return done(["No test failed: there is no target to bisect."]);
    }

    const isolationProblem = await this.verifyIsolation(failure, args);
    if (isolationProblem) return isolationProblem;

    const state: LeakFinderState = {
      steps: "a",
      target: failure.id,
      isolationVerified: true,
      items: results.map(snapshotItem),
    };
    await this.store.save(state);
    return progress([
      `Target set to: ${state.target}`,
      `Suspects remaining: ${failureIndex}`,
      "Run the same command again to bisect the tests before the target.",
    ]);
  }

  /** Only a single matching target that meets Playwright's expectation is a reliable baseline. */
  private async verifyIsolation(target: SuiteItem, args: string[]): Promise<LeakFinderReport | null> {
    const { results: isolated } = await this.runner.run({
      locations: [target],
      passthroughArgs: args,
      quiet: true,
      requireAllRepeats: true,
    });
    const alone = isolated.length === 1 ? isolated[0] : undefined;
    const verdict = alone?.id === target.id && alone.file === target.file && alone.line === target.line
      ? alone.status
      : undefined;
    if (verdict === "passed") return null;
    if (verdict === "failed") {
      return done([
        `${target.id} has an unexpected outcome on its own; no earlier test is needed to reproduce it.`,
        "Fix that test first, then run the leak finder again.",
      ]);
    }
    return done([
      `Could not verify ${target.id} on its own, so the search is inconclusive.`,
      "Check that its file:line selects only the target and that the target does not skip in isolation.",
    ]);
  }

  /** Subsequent runs: execute one bisection step and record the outcome. */
  private async bisect(
    state: LeakFinderState,
    args: string[],
  ): Promise<LeakFinderReport> {
    // Only legacy searches lack a snapshot and need another Playwright invocation.
    const items =
      state.items.length > 0
        ? state.items
        : (await this.runner.list(args)).map(snapshotItem);
    const targetIndex = items.findIndex((item) => item.id === state.target);
    if (targetIndex <= 0) {
      await this.runner.run({ passthroughArgs: args });
      const reason =
        targetIndex === 0
          ? "No tests run before the target, so there is nothing to bisect."
          : "The target was not found among the collected tests, so nothing was skipped.";
      return done([reason, `Current target is: ${state.target}`]);
    }

    const range = suspectRange(targetIndex, state.steps);
    const suspectCount = range.end - range.start;
    if (suspectCount === 0) {
      return done([
        "The search cannot narrow any further: no single earlier test makes the target fail.",
        "The leak probably needs more than one test, so bisection cannot pin it down.",
        "Run --reset to start over.",
      ]);
    }

    if (state.isolationVerified !== true) {
      const isolationProblem = await this.verifyIsolation(items[targetIndex]!, args);
      if (isolationProblem) return isolationProblem;
      state = { ...state, items, isolationVerified: true };
      await this.store.save(state);
    }

    const { results } = await this.runner.run({
      locations: selectPartition(items, targetIndex, range),
      passthroughArgs: args,
    });

    const target = results.find((result) => result.id === state.target);
    if (!target || target.status === "skipped") {
      return done([
        "The target did not run, so this step is inconclusive.",
        `Current target is: ${state.target}`,
      ]);
    }

    // A moved line or shared file:line may have selected a different test.
    if (!matchesSelection(results, items, range, target.id)) {
      return done([
        "The tests that ran are not the ones selected, so this step is inconclusive.",
        "Check for changed test order, moved spec lines, or several tests sharing a file:line.",
        "Run --reset to start over.",
      ]);
    }

    const targetFailed = target.status === "failed";
    const leakCandidate = suspectCount === 1 ? items[range.start]!.id : null;
    if (targetFailed && leakCandidate) {
      return done(
        [
          "We found a leak!",
          `Leak found in: ${leakCandidate}`,
          "This search is finished but its state is still saved: run --reset before starting another one.",
        ],
        leakCandidate,
      );
    }

    // Narrow to the half that still hides the leak, then test its first half ("a") next.
    const narrowedSteps = targetFailed ? state.steps : otherHalfSteps(state.steps);
    const nextState: LeakFinderState = { ...state, steps: `${narrowedSteps}a`, items };
    await this.store.save(nextState);
    const remaining = suspectRange(targetIndex, narrowedSteps);
    return progress([
      targetFailed
        ? "The group selected still fails. Let's do a new partition."
        : "We reached the target and nothing failed. Let's bisect the other half.",
      `Suspects remaining: ${remaining.end - remaining.start}`,
      `Current target is: ${nextState.target}`,
    ]);
  }
}

function matchesSelection(
  results: readonly TestResult[],
  items: readonly SuiteItem[],
  range: SuspectRange,
  targetId: string,
): boolean {
  const suspectCount = range.end - range.start;
  if (results.length !== suspectCount + 1 || results[suspectCount]?.id !== targetId) {
    return false;
  }
  const seen = new Set<string>();
  for (let i = 0; i < suspectCount; i++) {
    const { id } = results[i]!;
    if (id !== items[range.start + i]!.id || seen.has(id)) {
      return false;
    }
    seen.add(id);
  }
  return true;
}

/**
 * The selected first half passed, so switch to its sibling half (`...a` -> `...b`).
 * Falls back to `"a"` for legacy or hand-edited states not ending in `"a"`.
 */
function otherHalfSteps(steps: string): string {
  return steps.endsWith("a") ? `${steps.slice(0, -1)}b` : "a";
}

function snapshotItem({ id, file, line }: SuiteItem): SuiteItem {
  return { id, file, line };
}

function done(lines: string[], leakCandidate: string | null = null): LeakFinderReport {
  return { done: true, lines, leakCandidate };
}

function progress(lines: string[]): LeakFinderReport {
  return { done: false, lines, leakCandidate: null };
}
