import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");

// Validates the artifact `npm pack` produces: contents, a CLI wired through a
// consumer node_modules, a full leak hunt against the demo, and the API
// surface — all from temp dirs under the repo, removed in afterAll.

let tmpRoot: string;
let entries: string[];
let consumer: string;

function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 110_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(repoRoot, "tests", ".tmp-package-"));

  // prepack rebuilds dist; that is expected.
  const pack = await run("npm", ["pack", "--pack-destination", tmpRoot], repoRoot, 110_000, {
    ...process.env,
    npm_config_cache: path.join(tmpRoot, "npm-cache"),
  });
  expect(pack.code, pack.stderr).toBe(0);
  const tarballs = (await readdir(tmpRoot)).filter((file) => file.endsWith(".tgz"));
  expect(tarballs).toHaveLength(1);
  const tarball = path.join(tmpRoot, tarballs[0]!);

  const listing = await run("tar", ["-tzf", tarball], repoRoot);
  expect(listing.code, listing.stderr).toBe(0);
  entries = listing.stdout
    .trim()
    .split("\n")
    .map((entry) => entry.replace(/^package\//u, ""));

  await run("tar", ["-xzf", tarball, "-C", tmpRoot], repoRoot);
  const packageDir = path.join(tmpRoot, "package");

  // Consumer install: deps are symlinked from the repo so no network is needed.
  consumer = path.join(tmpRoot, "consumer");
  const modules = path.join(consumer, "node_modules");
  await mkdir(path.join(modules, "@playwright"), { recursive: true });
  await writeFile(path.join(consumer, "package.json"), '{"type": "module"}\n');
  await symlink(packageDir, path.join(modules, "playwright-leak-finder"));
  for (const name of ["@playwright/test", "playwright", "playwright-core", "fsevents"]) {
    const target = path.join(repoRoot, "node_modules", name);
    if (existsSync(target)) {
      await symlink(target, path.join(modules, name));
    }
  }
  await cp(path.join(repoRoot, "demo"), path.join(consumer, "demo"), { recursive: true });
}, 240_000);

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("packaged artifact", () => {
  it("contains only package.json, README.md, LICENSE and dist/*", async () => {
    for (const entry of entries) {
      const allowed =
        entry === "" ||
        entry === "package.json" ||
        entry === "README.md" ||
        entry === "LICENSE" ||
        entry.startsWith("dist/");
      expect(allowed, `unexpected entry "${entry}"`).toBe(true);
    }
    expect(entries).toContain("package.json");
    expect(entries).toContain("README.md");
    expect(entries).toContain("LICENSE");
  });

  it("ships the files that exports and bin point at", async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      exports: Record<string, { types: string; default: string }>;
      bin: Record<string, string>;
    };
    const strip = (file: string): string => file.replace(/^\.\//u, "");
    expect(entries).toContain("dist/index.mjs");
    expect(entries).toContain("dist/cli.mjs");
    expect(entries).toContain("dist/index.d.mts");
    expect(entries).toContain(strip(pkg.exports["."]!.default));
    expect(entries).toContain(strip(pkg.exports["."]!.types));
    expect(entries).toContain(strip(pkg.bin["playwright-leak-finder"]!));
  });

  it("cli --help exits 0 and prints usage", async () => {
    const cli = path.join(consumer, "node_modules/playwright-leak-finder/dist/cli.mjs");
    const help = await run(process.execPath, [cli, "--help"], consumer, 30_000);
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain("Usage:");
    expect(help.stdout).toContain("playwright-leak-finder");
  }, 30_000);

  it("finds the leak in the demo suite via --auto", async () => {
    const cli = path.join(consumer, "node_modules/playwright-leak-finder/dist/cli.mjs");
    const hunt = await run(process.execPath, [cli, "--auto", "--config", "demo"], consumer);
    expect(hunt.code, hunt.stdout + hunt.stderr).toBe(0);
    expect(hunt.stdout).toContain("Leak found in: demo.spec.ts › test3");
  }, 120_000);

  it("exports the public API from the packaged entry point", async () => {
    const entry = pathToFileURL(
      path.join(consumer, "node_modules/playwright-leak-finder/dist/index.mjs"),
    ).href;
    const mod = (await import(entry)) as Record<string, unknown>;
    for (const name of [
      "LeakFinder",
      "PlaywrightRunner",
      "FileStateStore",
      "bizect",
      "parseCliArgs",
      "HELP",
      "emptyState",
      "DEFAULT_STATE_DIRECTORY",
    ]) {
      expect(mod[name], name).toBeDefined();
    }
  });
});
