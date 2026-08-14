import { describe, expect, it } from "vitest";
import { bizect } from "playwright-leak-finder";

const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

describe("bizect", () => {
  it.each<[string, number[]]>([
    ["a", [0, 1, 2, 3, 4, 9]],
    ["aa", [0, 1, 2, 9]],
    ["aaa", [0, 1, 9]],
    ["aaaa", [0, 9]],
    ["aaaaa", [0, 9]],
    ["b", [5, 6, 7, 8, 9]],
    ["ba", [5, 6, 9]],
    ["baa", [5, 9]],
    ["bab", [6, 9]],
    ["bb", [7, 8, 9]],
    ["bba", [7, 9]],
    ["bbb", [8, 9]],
  ])("selects partition %s as %j", (steps, expected) => {
    expect(bizect(items, steps)).toEqual(expected);
  });

  it.each<[number[], string, number[]]>([
    [[7], "a", [7]],
    [[7], "b", [7]],
    [[0, 1], "a", [0, 1]],
    // "b" empties the only suspect: the selection shrinks to the target alone,
    // which LeakFinder must refuse to run (selection.length < 2).
    [[0, 1], "b", [1]],
    [[0, 1, 2], "a", [0, 2]],
    [[0, 1, 2], "b", [1, 2]],
    [[0, 1, 2], "bb", [2]],
  ])("selects partition %s of pool %j as %j", (pool, steps, expected) => {
    expect(bizect(pool, steps)).toEqual(expected);
  });

  it("returns a copy of the items when there are no steps", () => {
    const result = bizect(items);
    expect(result).toEqual(items);
    expect(result).not.toBe(items);
  });

  it("returns an empty selection for no items", () => {
    expect(bizect([], "a")).toEqual([]);
  });

  it("rejects steps other than a/b", () => {
    expect(() => bizect(items, "ax")).toThrow(/Invalid steps/);
  });

  it.each(["A", "ab ", " ", "a,b", "aa\n", "1"])(
    "rejects the invalid step string %j",
    (steps) => {
      expect(() => bizect(items, steps)).toThrow(/Invalid steps/);
    },
  );

  it("does not mutate the input", () => {
    const original = [...items];
    bizect(items, "abab");
    expect(items).toEqual(original);
  });

  // The search relies on three invariants at every step: the target runs last,
  // only real suspects are selected, and the pool never grows. Breaking any of
  // them makes the finder blame a test that was never in the suspect set.
  it.each(["", "a", "b", "aa", "ab", "ba", "bb", "aba", "bab", "abab", "bbbb", "aaaaaaaa"])(
    "keeps the target last, the members original, and the size non-growing for steps %j",
    (steps) => {
      for (const size of [1, 2, 3, 4, 5, 7, 8, 33]) {
        const pool = Array.from({ length: size }, (_, index) => index);
        const selection = bizect(pool, steps);

        expect(selection.at(-1)).toBe(pool.at(-1));
        expect(selection.length).toBeGreaterThanOrEqual(1);
        expect(selection.length).toBeLessThanOrEqual(pool.length);
        expect(new Set(selection).size).toBe(selection.length);
        for (const member of selection) {
          expect(pool).toContain(member);
        }
        // Declaration order is the premise of the whole search.
        expect([...selection].sort((a, b) => a - b)).toEqual(selection);
      }
    },
  );

  it("shrinks or stays put as steps are appended, never grows", () => {
    const pool = Array.from({ length: 64 }, (_, index) => index);
    for (const branch of ["a", "b"]) {
      let steps = "";
      let previous = bizect(pool, steps).length;
      for (let depth = 0; depth < 12; depth += 1) {
        steps += branch;
        const current = bizect(pool, steps).length;
        expect(current).toBeLessThanOrEqual(previous);
        previous = current;
      }
      // Descending "a" bottoms out at [first, target]; "b" empties the pool
      // down to the target alone, which LeakFinder refuses to run.
      expect(previous).toBe(branch === "a" ? 2 : 1);
    }
  });
});
