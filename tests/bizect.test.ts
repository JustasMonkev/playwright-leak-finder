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
});
