import { nextUncheckedSingleton, selectPartition, suspectRange, type SuspectRange } from "./bizect";
import type { TestResult, TestRunner } from "./playwright";
import { parseProjectFilters } from "./playwright-options";
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
    const savedArgs = state.playwrightArgs;
    if (state.target === null || savedArgs === undefined) {
      return this.captureTarget(passthroughArgs, state.target);
    }
    if (savedArgs.length !== passthroughArgs.length ||
      savedArgs.some((arg, index) => arg !== passthroughArgs[index])) {
      // This path bypasses the runner, but reserved flags are still CLI errors.
      parseProjectFilters(passthroughArgs);
      return done([
        "The forwarded Playwright arguments differ from those used for the saved search.",
        "Use the same arguments to resume it, or run --reset before starting a different search.",
      ]);
    }
    return this.bisect(state, passthroughArgs);
  }

  /** First run: execute the suite until something fails and remember it. */
  private async captureTarget(args: string[], savedTarget: string | null): Promise<LeakFinderReport> {
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
    if (savedTarget !== null && failure.id !== savedTarget) {
      return done([
        `The first failure was ${failure.id}, not the saved target ${savedTarget}.`,
        "The saved search is unchanged. Run --reset to start a different search.",
      ]);
    }

    const isolationProblem = await this.verifyIsolation(failure, args);
    if (isolationProblem) return isolationProblem;

    const state: LeakFinderState = {
      steps: "a",
      target: failure.id,
      isolationVerified: true,
      allIsolatedRepeatsVerified: true,
      playwrightArgs: [...args],
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

    let range = suspectRange(targetIndex, state.steps);
    const scanning = range.start === range.end;
    if (scanning) {
      const index = nextUncheckedSingleton(targetIndex, state.steps, state.singletonIndex ?? 0);
      if (index >= targetIndex) return noSingleLeak();
      range = { start: index, end: index + 1 };
    }
    const suspectCount = range.end - range.start;

    if (state.allIsolatedRepeatsVerified !== true) {
      const isolationProblem = await this.verifyIsolation(items[targetIndex]!, args);
      if (isolationProblem) return isolationProblem;
      state = { ...state, items, isolationVerified: true, allIsolatedRepeatsVerified: true };
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

    // A passing group can mask a leaking member. If the binary path ends
    // without a witness, check the singletons it never replayed on their own.
    const narrowedSteps = targetFailed ? state.steps : otherHalfSteps(state.steps);
    const nextState: LeakFinderState = scanning
      ? { ...state, items }
      : { ...state, steps: `${narrowedSteps}a`, items };
    const remaining = suspectRange(targetIndex, narrowedSteps);
    if (scanning || remaining.start === remaining.end) {
      const next = nextUncheckedSingleton(targetIndex, nextState.steps, scanning ? range.end : 0);
      if (next >= targetIndex) return noSingleLeak();
      await this.store.save({ ...nextState, singletonIndex: next });
      return progress([
        scanning
          ? "This individual test did not reproduce the failure."
          : "Bisection exhausted its path; another test could have masked a leak in a passing group.",
        `Next individual replay: ${items[next]!.id}`,
      ]);
    }
    await this.store.save(nextState);
    return progress([
      targetFailed
        ? "The group selected still fails. Let's do a new partition."
        : "We reached the target and nothing failed. Let's bisect the other half.",
      `Suspects remaining: ${remaining.end - remaining.start}`,
      `Current target is: ${nextState.target}`,
    ]);
  }
}

function noSingleLeak(): LeakFinderReport {
  return done([
    "No individual predecessor reproduced the target failure in this search.",
    "The original failure may require a combination of tests, or may not reproduce consistently.",
    "Run --reset to start over.",
  ]);
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
