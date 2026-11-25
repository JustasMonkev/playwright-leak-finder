export interface SuspectRange {
  readonly start: number;
  /** Exclusive; the target is never in the suspect range. */
  readonly end: number;
}

export function isValidSteps(steps: string): boolean {
  return /^[ab]*$/u.test(steps);
}

/**
 * Select the next partition for the leak finder's binary search.
 *
 * `items` is the ordered list of tests that ran before the failing test,
 * with the failing test (the "target") as the last element. Each step
 * narrows the group: `"a"` keeps the first half, `"b"` keeps the second
 * half. The target is re-appended after every step so it always runs last.
 *
 * @example
 * bizect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "a")  // [0, 1, 2, 3, 4, 9]
 * bizect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "ba") // [5, 6, 9]
 */
export function bizect<T>(items: readonly T[], steps = ""): T[] {
  if (steps === "") return [...items];
  const targetIndex = items.length - 1;
  const range = suspectRange(Math.max(0, targetIndex), steps);
  return selectPartition(items, targetIndex, range);
}

/**
 * Compute the half-open `[start, end)` range of suspects selected by `steps`
 * from an initial pool of `suspectCount` tests before the target.
 */
export function suspectRange(suspectCount: number, steps: string): SuspectRange {
  if (!isValidSteps(steps)) {
    throw new Error(`Invalid steps "${steps}": only "a" and "b" are allowed`);
  }
  let start = 0;
  let end = suspectCount;
  for (const step of steps) {
    // Odd-sized pools give the extra suspect to the first half ("a").
    const middle = firstHalfEnd(start, end);
    if (step === "a") {
      end = middle;
    } else {
      start = middle;
    }
  }
  return { start, end };
}

function firstHalfEnd(start: number, end: number): number {
  return start + Math.ceil((end - start) / 2);
}

/** Skip singleton replays already observed on the exhausted binary-search path. */
export function nextUncheckedSingleton(count: number, steps: string, from: number): number {
  let start = 0;
  let end = count;
  for (const step of steps) {
    if (start === end) break;
    // Each decision followed a replay of the first half, even when we took "b".
    const middle = firstHalfEnd(start, end);
    if (middle === start + 1 && from === start) from++;
    if (step === "a") end = middle;
    else start = middle;
  }
  return from;
}

export function selectPartition<T>(
  items: readonly T[],
  targetIndex: number,
  { start, end }: SuspectRange,
): T[] {
  if (targetIndex < 0) return [];
  const selection = new Array<T>(end - start + 1);
  // Copy by index, not slice: a hole in the input is an explicit undefined
  // in the returned array, just as it is when spreading the input.
  for (let i = start; i < end; i++) {
    selection[i - start] = items[i]!;
  }
  selection[end - start] = items[targetIndex]!;
  return selection;
}
