import { describe, expect, it } from "vitest";
import {
  LeakFinder,
  emptyState,
  type LeakFinderState,
  type RunOptions,
  type RunOutcome,
  type StateStore,
  type TestItem,
  type TestRunner,
} from "playwright-leak-finder";

class MemoryStateStore implements StateStore {
  private state: LeakFinderState = emptyState();

  async load(): Promise<LeakFinderState> {
    return { ...this.state, items: [...this.state.items] };
  }

  async save(state: LeakFinderState): Promise<void> {
    this.state = { ...state, items: [...state.items] };
  }

  async clear(): Promise<void> {
    this.state = emptyState();
  }
}

/**
 * Simulates a suite where `leaky` pollutes shared state, making `victim`
 * fail whenever it runs after `leaky` in the same session.
 */
class FakeRunner implements TestRunner {
  constructor(
    private readonly items: TestItem[],
    private readonly leaky: string,
    private readonly victim: string,
  ) {}

  async list(): Promise<TestItem[]> {
    return this.items;
  }

  async run(options: RunOptions = {}): Promise<RunOutcome> {
    const selected = options.locations
      ? this.items.filter((item) =>
          options.locations!.some(
            (location) => location.file === item.file && location.line === item.line,
          ),
        )
      : this.items;

    const results: RunOutcome["results"] = [];
    let leaked = false;
    for (const item of selected) {
      if (item.id === this.leaky) {
        leaked = true;
      }
      const failed = item.id === this.victim && leaked;
      results.push({ id: item.id, file: item.file, line: item.line, status: failed ? "failed" : "passed" });
      if (failed && options.stopOnFirstFailure) {
        break;
      }
    }
    const exitCode = results.some((result) => result.status === "failed") ? 1 : 0;
    return { exitCode, results };
  }
}

const suite = (titles: string[]): TestItem[] =>
  titles.map((title, index) => ({
    id: `demo.spec.ts › ${title}`,
    file: "demo.spec.ts",
    line: index + 1,
  }));

const leakySuite = () =>
  new FakeRunner(
    suite(["test1", "test2", "test3", "test4", "test5", "test6"]),
    "demo.spec.ts › test3",
    "demo.spec.ts › test5",
  );

describe("LeakFinder", () => {
  it("sets the target on the first failing run", async () => {
    const finder = new LeakFinder(leakySuite(), new MemoryStateStore());

    const result = await finder.run();

    expect(result.lines).toEqual([
      "Target set to: demo.spec.ts › test5",
      "Suspects remaining: 4",
      "Run the same command again to bisect the tests before the target.",
    ]);
    expect(result.done).toBe(false);
    expect(result.leakCandidate).toBeNull();
  });

  it("bisects the other half when the selected group passes", async () => {
    const finder = new LeakFinder(leakySuite(), new MemoryStateStore());
    await finder.run();

    // Step "a" runs test1, test2 and the target: the leak is not in there.
    const result = await finder.run();

    expect(result.lines[0]).toBe(
      "We reached the target and nothing failed. Let's bisect the other half.",
    );
    expect(result.lines).toContain("Suspects remaining: 2");
    expect(result.done).toBe(false);
  });

  it("converges on the leaking test", async () => {
    const finder = new LeakFinder(leakySuite(), new MemoryStateStore());
    await finder.run();

    let result = await finder.run();
    for (let step = 0; step < 10 && result.leakCandidate === null; step += 1) {
      result = await finder.run();
    }

    expect(result.leakCandidate).toBe("demo.spec.ts › test3");
    expect(result.done).toBe(true);
    expect(result.lines).toEqual([
      "We found a leak!",
      "Leak found in: demo.spec.ts › test3",
      "This search is finished but its state is still saved: run --reset before starting another one.",
    ]);
  });

  it("keeps narrowing when the selected group still fails", async () => {
    // The leak sits right before a late target, so step "a" still fails.
    const runner = new FakeRunner(
      suite(["test1", "test2", "test3", "test4", "test5", "test6", "test7", "test8"]),
      "demo.spec.ts › test1",
      "demo.spec.ts › test8",
    );
    const store = new MemoryStateStore();
    const finder = new LeakFinder(runner, store);
    await finder.run();

    const result = await finder.run();

    expect(result.lines[0]).toBe(
      "The group selected still fails. Let's do a new partition.",
    );
    expect((await store.load()).steps).toBe("aa");
  });

  it("reports when no test fails on the first run", async () => {
    const runner = new FakeRunner(suite(["test1", "test2"]), "none", "none");
    const finder = new LeakFinder(runner, new MemoryStateStore());

    const result = await finder.run();

    expect(result.lines).toEqual(["No test failed: there is no target to bisect."]);
    expect(result.done).toBe(true);
  });

  it("distinguishes an empty collection from a passing suite", async () => {
    const finder = new LeakFinder(
      new FakeRunner([], "none", "none"),
      new MemoryStateStore(),
    );

    const result = await finder.run();

    expect(result.lines[0]).toBe(
      "No tests were collected, so there is nothing to bisect.",
    );
    expect(result.lines[1]).toMatch(/config, project and filters/);
  });

  it("refuses to hunt a target that fails on its own", async () => {
    // leaky === victim: it fails whether or not anything ran before it.
    const runner = new FakeRunner(
      suite(["test1", "test2", "test3"]),
      "demo.spec.ts › test3",
      "demo.spec.ts › test3",
    );
    const store = new MemoryStateStore();
    const finder = new LeakFinder(runner, store);

    const result = await finder.run();

    expect(result.lines[0]).toBe(
      "demo.spec.ts › test3 fails on its own, so no earlier test is leaking into it.",
    );
    expect(result.leakCandidate).toBeNull();
    expect((await store.load()).target).toBeNull();
  });

  it("stops instead of looping when no single test reproduces the failure", async () => {
    // The victim only fails when BOTH earlier tests ran, so every half passes
    // and bisection can never pin it on one test.
    class PairLeakRunner implements TestRunner {
      private readonly items = suite(["test1", "test2", "test3"]);

      async list(): Promise<TestItem[]> {
        return this.items;
      }

      async run(options: RunOptions = {}): Promise<RunOutcome> {
        const selected = options.locations
          ? this.items.filter((item) =>
              options.locations!.some(
                (location) => location.file === item.file && location.line === item.line,
              ),
            )
          : this.items;
        const ids = selected.map((item) => item.id);
        const fails =
          ids.includes("demo.spec.ts › test1") && ids.includes("demo.spec.ts › test2");
        const results: RunOutcome["results"] = selected.map((item) => ({
          ...item,
          status: item.id === "demo.spec.ts › test3" && fails ? "failed" : "passed",
        }));
        return {
          exitCode: results.some((r) => r.status === "failed") ? 1 : 0,
          results,
        };
      }
    }

    const store = new MemoryStateStore();
    const finder = new LeakFinder(new PairLeakRunner(), store);
    await finder.run();

    let result = await finder.run();
    for (let step = 0; step < 10 && !result.lines[0]!.startsWith("The search"); step += 1) {
      result = await finder.run();
    }

    expect(result.lines[0]).toBe(
      "The search cannot narrow any further: no single earlier test makes the target fail.",
    );
    expect(result.leakCandidate).toBeNull();
  });

  it("runs everything when the target is no longer collected", async () => {
    const store = new MemoryStateStore();
    await store.save({ steps: "a", target: "demo.spec.ts › removed", items: suite(["test1", "test2", "test3", "test4", "test5", "test6"]) });
    const finder = new LeakFinder(leakySuite(), store);

    const result = await finder.run();

    expect(result.lines[0]).toBe(
      "The target was not found among the collected tests, so nothing was skipped.",
    );
  });

  it("runs everything when nothing precedes the target", async () => {
    const runner = new FakeRunner(
      suite(["test1", "test2"]),
      "none",
      "none",
    );
    const store = new MemoryStateStore();
    await store.save({ steps: "a", target: "demo.spec.ts › test1", items: suite(["test1", "test2"]) });
    const finder = new LeakFinder(runner, store);

    const result = await finder.run();

    expect(result.lines[0]).toBe(
      "No tests run before the target, so there is nothing to bisect.",
    );
  });

  it("collects the suite once when resuming a state saved without a snapshot", async () => {
    // State files written before suite snapshots existed carry a target and
    // steps but no items. Resuming one must fall back to listing the suite
    // instead of treating the pool as empty and giving up.
    const store = new MemoryStateStore();
    await store.save({ steps: "a", target: "demo.spec.ts › test5", items: [] });
    let listCalls = 0;
    const leaky = leakySuite();
    class CountingRunner implements TestRunner {
      async list(): Promise<TestItem[]> {
        listCalls += 1;
        return leaky.list();
      }

      async run(options: RunOptions = {}): Promise<RunOutcome> {
        return leaky.run(options);
      }
    }
    const finder = new LeakFinder(new CountingRunner(), store);

    const result = await finder.run();

    expect(listCalls).toBe(1);
    expect(result.lines[0]).toBe(
      "We reached the target and nothing failed. Let's bisect the other half.",
    );
    expect(result.lines).toContain("Suspects remaining: 2");
    // The snapshot stays empty, so the next step lists again rather than
    // inventing an ordering.
    expect((await store.load()).items).toEqual([]);
  });

  it("bisects from the state snapshot without listing", async () => {
    const leakyRunner = leakySuite();
    // Wrap to prevent list() calls after capturing the snapshot.
    class NoListRunner implements TestRunner {
      async list(): Promise<TestItem[]> {
        throw new Error("list should not be called");
      }

      async run(options: RunOptions = {}): Promise<RunOutcome> {
        return leakyRunner.run(options);
      }
    }

    const store = new MemoryStateStore();
    const finder = new LeakFinder(new NoListRunner(), store);

    // First run captures target and items snapshot.
    await finder.run();

    // Second run should bisect using the snapshot without calling list().
    const result = await finder.run();

    expect(result.lines[0]).toBe(
      "We reached the target and nothing failed. Let's bisect the other half.",
    );
  });
});
