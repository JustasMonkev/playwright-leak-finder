import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("clears the saved state", async () => {
    await store.save({ steps: "a", target: "t", items: [] });
    await store.clear();
    expect(await store.load()).toEqual(emptyState());
  });

  it("clearing a never-saved state is a no-op", async () => {
    await expect(store.clear()).resolves.toBeUndefined();
  });
});
