import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isValidSteps } from "./bizect";

export interface SuiteItem {
  id: string;
  file: string;
  line: number;
}

export interface LeakFinderState {
  /** Sequence of "a"/"b" partition choices taken so far. */
  steps: string;
  /** Absent in saved searches that predate mandatory verification of the isolated target. */
  isolationVerified?: true;
  /** Id of the failing test whose leak we are hunting, if any. */
  target: string | null;
  /** Ordered snapshot of the collected suite, taken on the first run. */
  items: SuiteItem[];
}

export function emptyState(): LeakFinderState {
  return { steps: "", target: null, items: [] };
}

export interface StateStore {
  load(): Promise<LeakFinderState>;
  save(state: LeakFinderState): Promise<void>;
  clear(): Promise<void>;
}

export const DEFAULT_STATE_DIRECTORY = ".playwright-leak-finder";

/** Persists the search state as JSON so it survives between CLI runs. */
export class FileStateStore implements StateStore {
  private readonly file: string;

  constructor(directory: string = DEFAULT_STATE_DIRECTORY) {
    this.file = path.resolve(directory, "state.json");
  }

  async load(): Promise<LeakFinderState> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.file, "utf8"));
      return parseState(raw) ?? emptyState();
    } catch {
      // A missing or corrupt file simply starts a fresh search.
      return emptyState();
    }
  }

  async save(state: LeakFinderState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`);
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveLineNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSuiteItem(value: unknown): value is SuiteItem {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.file) &&
    isPositiveLineNumber(value.line)
  );
}

function parseState(value: unknown): LeakFinderState | null {
  if (!isRecord(value)) {
    return null;
  }
  const { steps, target, items } = value;
  if (
    typeof steps !== "string" ||
    !isValidSteps(steps) ||
    (target !== null && typeof target !== "string") ||
    !Array.isArray(items) ||
    !items.every(isSuiteItem)
  ) {
    return null;
  }
  if (!hasConsistentSearchState(steps, target, items)) {
    return null;
  }
  return value.isolationVerified === true
    ? { steps, target, items, isolationVerified: true }
    : { steps, target, items };
}

function hasConsistentSearchState(
  steps: string,
  target: string | null,
  items: readonly SuiteItem[],
): boolean {
  if (target === null) {
    // An idle state cannot carry leftover bisection steps or a suite snapshot.
    return steps.length === 0 && items.length === 0;
  }
  if (target.length === 0 || steps.length === 0) {
    return false;
  }
  // Empty snapshots are accepted for state files written by versions that
  // predate persisted suite items; the runner will collect them once.
  return items.length === 0 || items.some((item) => item.id === target);
}
