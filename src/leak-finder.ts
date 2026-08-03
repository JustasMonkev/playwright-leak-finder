import { bizect } from "./bizect";
import type { TestRunner } from "./playwright";
import type { LeakFinderState, StateStore } from "./state";

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
    return state.target === null
      ? this.captureTarget(passthroughArgs)
      : this.bisect(state, passthroughArgs);
  }

  /** First run: execute the suite until something fails and remember it. */
  private async captureTarget(args: string[]): Promise<LeakFinderReport> {
    const outcome = await this.runner.run({
      stopOnFirstFailure: true,
      passthroughArgs: args,
    });
    if (outcome.results.length === 0) {
      return done([
        "No tests were collected, so there is nothing to bisect.",
        "Check the config, project and filters you forwarded to `playwright test`.",
      ]);
    }
    const failure = outcome.results.find((result) => result.status === "failed");
    if (!failure) {
      return done(["No test failed: there is no target to bisect."]);
    }
    // A test that fails alone has no leak to hunt; without this the search
    // would happily converge and blame whichever test it narrowed down to.
    const alone = await this.runner.run({
      locations: [failure],
      passthroughArgs: args,
      // Quiet: a second "test5 passed" right after "test5 failed" reads as a
      // bug. The report line below explains the check instead.
      quiet: true,
    });
    // Only trust this when the filter really did select just the target: with
    // loop-generated tests several can share its file:line.
    const ranAlone = alone.results.length === 1 && alone.results[0]!;
    if (ranAlone && ranAlone.id === failure.id && ranAlone.status === "failed") {
      return done([
        `${failure.id} fails on its own, so no earlier test is leaking into it.`,
        "Fix that test first, then run the leak finder again.",
      ]);
    }
    const items = outcome.results.map(({ id, file, line }) => ({ id, file, line }));
    const state: LeakFinderState = { steps: "a", target: failure.id, items };
    await this.store.save(state);
    return progress([
      `Target set to: ${state.target}`,
      // Tests after the target can appear in the report as skipped; only the
      // ones that ran before it are suspects.
      `Suspects remaining: ${outcome.results.indexOf(failure)}`,
      "Run the same command again to bisect the tests before the target.",
    ]);
  }

  /** Subsequent runs: execute one bisection step and record the outcome. */
  private async bisect(
    state: LeakFinderState,
    args: string[],
  ): Promise<LeakFinderReport> {
    // Use snapshot to avoid a second Playwright spawn per step.
    const items = state.items.length > 0 ? state.items : await this.runner.list(args);
    const targetIndex = items.findIndex((item) => item.id === state.target);
    if (targetIndex <= 0) {
      await this.runner.run({ passthroughArgs: args });
      const reason =
        targetIndex === 0
          ? "No tests run before the target, so there is nothing to bisect."
          : "The target was not found among the collected tests, so nothing was skipped.";
      return done([reason, `Current target is: ${state.target}`]);
    }

    const pool = items.slice(0, targetIndex + 1);
    const selection = bizect(pool, state.steps);
    // Nothing left to suspect: the halves have been exhausted without the
    // target failing, so no single earlier test reproduces it. Without this
    // the search keeps appending steps and re-running the target forever.
    if (selection.length < 2) {
      return done([
        "The search cannot narrow any further: no single earlier test makes the target fail.",
        "The leak probably needs more than one test, so bisection cannot pin it down.",
        "Run --reset to start over.",
      ]);
    }
    // Down to one suspect plus the target: if the target still fails, that's our leak.
    const leakCandidate = selection.length === 2 ? selection[0]!.id : null;
    const outcome = await this.runner.run({
      locations: selection,
      passthroughArgs: args,
    });

    const target = outcome.results.find((result) => result.id === state.target);
    if (!target || target.status === "skipped") {
      return done([
        "The target did not run, so this step is inconclusive.",
        `Current target is: ${state.target}`,
      ]);
    }

    // `file:line` is not a unique test id: loop-generated tests share a line,
    // and edits shift lines under the saved snapshot. Either runs tests we did
    // not select, which would pin the leak on an innocent test. Refuse to
    // answer rather than answer wrongly.
    const selected = new Set(selection.map((item) => item.id));
    if (
      outcome.results.length !== selected.size ||
      outcome.results.some((result) => !selected.has(result.id))
    ) {
      return done([
        "The tests that ran are not the ones selected, so this step is inconclusive.",
        "Either a spec file changed lines since the search started, or several tests share a file:line.",
        "Run --reset to start over.",
      ]);
    }

    if (target.status === "failed" && leakCandidate) {
      return {
        done: true,
        leakCandidate,
        lines: [
          "We found a leak!",
          `Leak found in: ${leakCandidate}`,
          "This search is finished but its state is still saved: run --reset before starting another one.",
        ],
      };
    }

    const next: LeakFinderState =
      target.status === "failed"
        ? { ...state, steps: `${state.steps}a` }
        : { ...state, steps: stepsAfterTargetPassed(state.steps) };
    await this.store.save(next);
    // The saved steps always end in "a" (bisect the first half of the pool
    // narrowed so far); dropping that final step yields the pool itself.
    const suspects = bizect(pool, next.steps.slice(0, -1)).length - 1;
    return progress([
      target.status === "failed"
        ? "The group selected still fails. Let's do a new partition."
        : "We reached the target and nothing failed. Let's bisect the other half.",
      `Suspects remaining: ${suspects}`,
      `Current target is: ${next.target}`,
    ]);
  }
}

/** The selected group passed: the leak hides in the other half, descend into it. */
function stepsAfterTargetPassed(steps: string): string {
  return steps.endsWith("a") ? `${steps.slice(0, -1)}ba` : "aa";
}

function done(lines: string[]): LeakFinderReport {
  return { done: true, lines, leakCandidate: null };
}

function progress(lines: string[]): LeakFinderReport {
  return { done: false, lines, leakCandidate: null };
}
