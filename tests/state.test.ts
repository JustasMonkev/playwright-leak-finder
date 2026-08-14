import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStateStore, emptyState } from "playwright-leak-finder";

describe("FileStateStore", () => {
  let directory: string;
  let store: FileStateStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "leak-finder-state-"));
    store = new FileStateStore(directory);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("returns an empty state when nothing was saved", async () => {
    expect(await store.load()).toEqual(emptyState());
  });

  it("round-trips a saved state", async () => {
    const state = {
      steps: "ba",
      target: "demo.spec.ts › test5",
      items: [
        { id: "demo.spec.ts › test1", file: "demo.spec.ts", line: 3 },
        { id: "demo.spec.ts › test5", file: "demo.spec.ts", line: 12 },
      ],
    };
    await store.save(state);
    expect(await store.load()).toEqual(state);
  });

  it("loads a legacy active state without a suite snapshot", async () => {
    const state = { steps: "a", target: "demo.spec.ts › test5", items: [] };
    await store.save(state);
    expect(await store.load()).toEqual(state);
  });

  it("falls back to an empty state on a corrupt file", async () => {
    await writeFile(path.join(directory, "state.json"), "not json");
    expect(await store.load()).toEqual(emptyState());
  });

  it("falls back to an empty state on an unexpected shape", async () => {
    await writeFile(path.join(directory, "state.json"), '{"steps": 42}');
    expect(await store.load()).toEqual(emptyState());
  });

  it("falls back to an empty state when items have wrong shape", async () => {
    await writeFile(path.join(directory, "state.json"), '{"steps":"a","target":"t","items":[{"id":1}]}');
    expect(await store.load()).toEqual(emptyState());
  });

  it.each([
    ["a null item", '{"steps":"a","target":"t","items":[null]}'],
    ["a string item", '{"steps":"a","target":"t","items":["t"]}'],
    ["an array item", '{"steps":"a","target":"t","items":[[]]}'],
    ["a zero line", '{"steps":"a","target":"t","items":[{"id":"t","file":"f","line":0}]}'],
    ["a fractional line", '{"steps":"a","target":"t","items":[{"id":"t","file":"f","line":2.5}]}'],
    ["a non-integer line", '{"steps":"a","target":"t","items":[{"id":"t","file":"f","line":"3"}]}'],
    ["an unsafe line", `{"steps":"a","target":"t","items":[{"id":"t","file":"f","line":${Number.MAX_SAFE_INTEGER + 2}}]}`],
    ["steps outside the a/b alphabet", '{"steps":"ax","target":"t","items":[]}'],
    ["a JSON scalar", '"a string"'],
    ["JSON null", "null"],
    ["a target missing from a non-empty snapshot", '{"steps":"a","target":"t","items":[{"id":"other","file":"f","line":1}]}'],
    ["a done-looking state with no target but saved steps", '{"steps":"a","target":null,"items":[]}'],
    ["a cleared target with a leftover snapshot", '{"steps":"","target":null,"items":[{"id":"t","file":"f","line":1}]}'],
  ])("falls back to an empty state on %s", async (_name, contents) => {
    await writeFile(path.join(directory, "state.json"), contents);
    expect(await store.load()).toEqual(emptyState());
  });

  it("round-trips ids with unicode, separators and newlines", async () => {
    const state = {
      steps: "abab",
      target: "sub dir(1)/a+b [x].spec.ts › gröup › víctim — 🚀\ttab",
      items: [
        {
          id: "sub dir(1)/a+b [x].spec.ts › gröup › víctim — 🚀\ttab",
          file: "sub dir(1)/a+b [x].spec.ts",
          line: 4,
        },
      ],
    };
    await store.save(state);
    expect(await store.load()).toEqual(state);
  });

  // A truncated state.json is indistinguishable from a corrupt one, so load()
  // silently discards the whole search. Writing to a temporary file and
  // renaming keeps every observable state file complete.
  it("never exposes a partially written state to a concurrent reader", async () => {
    // Large enough that a single non-atomic write cannot land in one tick.
    const items = Array.from({ length: 30_000 }, (_, index) => ({
      id: `tests/spec-${index}.spec.ts › test ${index}`,
      file: `tests/spec-${index}.spec.ts`,
      line: index + 1,
    }));
    const state = { steps: "aba", target: items[0]!.id, items };
    await store.save(state);

    let writing = true;
    const writer = (async () => {
      for (let round = 0; round < 12; round += 1) {
        await store.save(state);
      }
      writing = false;
    })();

    let reads = 0;
    const lost: number[] = [];
    while (writing && reads < 400) {
      const loaded = await store.load();
      reads += 1;
      if (loaded.target === null) {
        lost.push(reads);
      }
    }
    await writer;

    expect(reads).toBeGreaterThan(0);
    expect(lost).toEqual([]);
  }, 30_000);

  it("leaves no temporary files behind after saving", async () => {
    await store.save({ steps: "a", target: "t", items: [] });
    await store.save({ steps: "ab", target: "t", items: [] });

    expect(await readdir(directory)).toEqual(["state.json"]);
  });

  it("removes the state directory it created", async () => {
    const nested = path.join(directory, ".playwright-leak-finder");
    const nestedStore = new FileStateStore(nested);
    await nestedStore.save({ steps: "a", target: "t", items: [] });

    await nestedStore.clear();

    // "state cleared" should not leave a dot-directory behind in the user's
    // project.
    expect(await readdir(directory)).toEqual([]);
    expect(await nestedStore.load()).toEqual(emptyState());
  });

  it("keeps a state directory that holds anything else", async () => {
    const nested = path.join(directory, ".playwright-leak-finder");
    const nestedStore = new FileStateStore(nested);
    await nestedStore.save({ steps: "a", target: "t", items: [] });
    await writeFile(path.join(nested, "notes.txt"), "mine\n");

    await nestedStore.clear();

    // rmdir refuses a non-empty directory, which is what stops the cleanup
    // from taking anything that is not ours.
    expect(await readdir(nested)).toEqual(["notes.txt"]);
  });

  it("clears the saved state", async () => {
    await store.save({ steps: "a", target: "t", items: [] });
    await store.clear();
    expect(await store.load()).toEqual(emptyState());
  });

  it("clearing a never-saved state is a no-op", async () => {
    await expect(store.clear()).resolves.toBeUndefined();
  });
});
