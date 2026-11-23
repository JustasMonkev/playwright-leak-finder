import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";

export const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export async function createProject(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(repoRoot, "tests", ".tmp-fixture-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return dir;
}

export function command(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function runCli(cwd: string, ...args: string[]) {
  // Vitest can set both color flags, triggering a Node warning on CLI stderr.
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return command(process.execPath, [path.join(repoRoot, "dist", "cli.mjs"), ...args], cwd, env);
}
