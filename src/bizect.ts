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
  if (!/^[ab]*$/u.test(steps)) {
    throw new Error(`Invalid steps "${steps}": only "a" and "b" are allowed`);
  }
  if (items.length === 0) {
    return [];
  }
  const target = items[items.length - 1]!;
  let selection = [...items];
  for (const step of steps) {
    const middle = Math.floor(selection.length / 2);
    selection =
      step === "a" ? selection.slice(0, middle) : selection.slice(middle, -1);
    selection.push(target);
  }
  return selection;
}
