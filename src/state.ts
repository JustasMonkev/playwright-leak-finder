import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SuiteItem {
  id: string;
  file: string;
  line: number;
}

export interface LeakFinderState {
  /** Sequence of "a"/"b" partition choices taken so far. */
  steps: string;
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
      if (isState(raw)) {
        return { steps: raw.steps, target: raw.target, items: raw.items };
      }
    } catch {
      // A missing or corrupt file simply starts a fresh search.
    }
    return emptyState();
  }

  async save(state: LeakFinderState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    // Write then rename, so an interrupted run cannot leave truncated JSON
    // that load() would silently discard along with the whole search. Each
    // writer gets its own temporary file so concurrent CLI runs cannot rename
    // the same path out from under each other.
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
    // The directory exists only to hold that file, so clearing the search
    // should not leave it behind. rmdir refuses a non-empty directory, which
    // is what keeps this from removing anything the user put there.
    try {
      await rmdir(path.dirname(this.file));
    } catch {
      // Never created, or not ours alone.
    }
  }
}

function isSuiteItem(value: unknown): value is SuiteItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { id, file, line } = value as Record<string, unknown>;
  return (
    typeof id === "string" &&
    id.length > 0 &&
    typeof file === "string" &&
    file.length > 0 &&
    typeof line === "number" &&
    Number.isSafeInteger(line) &&
    line > 0
  );
}

function isState(value: unknown): value is LeakFinderState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { steps, target, items } = value as Record<string, unknown>;
  if (
    typeof steps !== "string" ||
    !/^[ab]*$/u.test(steps) ||
    (target !== null && typeof target !== "string") ||
    !Array.isArray(items) ||
    !items.every(isSuiteItem)
  ) {
    return false;
  }
  if (target === null) {
    return steps.length === 0 && items.length === 0;
  }
  return (
    target.length > 0 &&
    steps.length > 0 &&
    // Empty snapshots are accepted for state files written by versions that
    // predate persisted suite items; the runner will collect them once.
    (items.length === 0 || items.some((item) => item.id === target))
  );
}
