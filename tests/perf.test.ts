import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bizect,
  emptyState,
  FileStateStore,
  LeakFinder,
  type RunOptions,
  type StateStore,
  type SuiteItem,
  type TestItem,
  type TestRunner,
} from "playwright-leak-finder";

// Performance regression smoke checks. Bounds sit far above the measured
// baselines on this machine (noted per test) so they never flake, while the
// regressions they exist for — an O(n²) selection or a quadratic/unbounded
// JSON rewrite — would take seconds to minutes at these sizes.

function makeItems(count: number): SuiteItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `tests/spec-${i % 500}.spec.ts › suite ${i % 25} › test ${i}`,
    file: `tests/spec-${i % 500}.spec.ts`,
    line: (i % 400) + 1,
  }));
}

function memoryStore(): StateStore {
  let state = emptyState();
  return {
    load: async () => state,
    save: async (next) => {
      state = next;
    },
    clear: async () => {
      state = emptyState();
    },
  };
}

/** In-memory suite: the target fails iff the leaker is part of the run. */
function fakeRunner(
  items: TestItem[],
  leakerId: string,
  targetId: string,
): TestRunner {
  return {
    list: async () => items,
    run: async (options: RunOptions = {}) => {
      const locations = options.locations;
      const selected = locations
        ? items.filter((item) =>
            locations.some(
              (location) =>
                location.file === item.file && location.line === item.line,
            ),
          )
        : items;
      const leaked = selected.some((item) => item.id === leakerId);
      return {
        exitCode: leaked ? 1 : 0,
        results: selected.map((item) => ({
          ...item,
          status: item.id === targetId && leaked ? "failed" : "passed",
        })),
      };
    },
  };
}

describe("performance", () => {
  it("bizects 100k items in a handful of steps quickly", () => {
    const items = Array.from({ length: 100_000 }, (_, i) => i);
    const expectedLengths: Record<string, number> = { a: 50_001, ab: 25_001, abababab: 391 };
    const start = performance.now();
    for (const [steps, length] of Object.entries(expectedLengths)) {
      const selection = bizect(items, steps);
      // Also pins correctness, so a "fast" regression that drops items cannot pass.
      expect(selection).toHaveLength(length);
      expect(selection.at(-1)).toBe(items.at(-1));
    }
    const elapsed = performance.now() - start;
    // Baseline: ~1.2ms total; bound is ~400x. O(n²) at n=100k takes tens of seconds.
    expect(elapsed).toBeLessThan(500);
  });

  it("a full hunt over 10k tests converges in O(log n) runs", async () => {
    // One suspect per file:line so the location filter is unambiguous. The
    // target runs last in every selection, so stopOnFirstFailure never
    // truncates the faked results.
    const target: TestItem = {
      id: "tests/target.spec.ts › target",
      file: "tests/target.spec.ts",
      line: 1,
    };
    const items: TestItem[] = [
      ...Array.from({ length: 10_000 }, (_, i) => ({
        id: `tests/spec-${i}.spec.ts › test ${i}`,
        file: `tests/spec-${i}.spec.ts`,
        line: 3,
      })),
      target,
    ];
    // First, middle and last suspect exercise both bisection branches.
    for (const leakerIndex of [0, 5_000, 9_999]) {
      const leaker = items[leakerIndex]!;
      const finder = new LeakFinder(
        fakeRunner(items, leaker.id, target.id),
        memoryStore(),
      );
      let report = await finder.run();
      let steps = 1;
      while (!report.done) {
        report = await finder.run();
        steps++;
        // A step that neither finishes nor advances would loop forever.
        expect(steps).toBeLessThanOrEqual(100);
      }
      expect(report.leakCandidate).toBe(leaker.id);
      // ceil(log2(n)) halvings, +2 slack for the capture run and the odd
      // remainders of floor(m/2)+1 halves. Baseline: 13-15 steps.
      expect(steps).toBeLessThanOrEqual(Math.ceil(Math.log2(items.length)) + 2);
    }
  });

  describe("FileStateStore", () => {
    let directory: string;

    beforeEach(async () => {
      directory = await mkdtemp(path.join(os.tmpdir(), "leak-finder-perf-"));
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it("round-trips a 50k-item state quickly and without file bloat", async () => {
      const store = new FileStateStore(directory);
      const state = {
        steps: "abab",
        target: "tests/spec-0.spec.ts › suite 0 › test 0",
        items: makeItems(50_000),
      };
      const start = performance.now();
      await store.save(state);
      const loaded = await store.load();
      const elapsed = performance.now() - start;
      // Also pins correctness, so an empty/truncated write cannot pass as "fast".
      expect(loaded).toEqual(state);
      // Baseline: save+load ~40ms; bound is ~125x. Quadratic JSON assembly takes minutes.
      expect(elapsed).toBeLessThan(5000);
      const { size } = await stat(path.join(directory, "state.json"));
      // Baseline: 6.8MB (pretty-printed). 3x catches state that grows per step,
      // e.g. a history array appended on every save.
      expect(size).toBeLessThan(20 * 1024 * 1024);
    }, 15_000);
  });
});
