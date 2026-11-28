import type { RunOptions } from "./playwright";

// Letting a forwarded flag override one of these would invalidate the search.
const RESERVED_ARGS = [
  "--reporter",
  "--workers",
  "-j",
  "--max-failures",
  "-x",
  "--list",
  "--retries",
  "--shard",
  "--repeat-each",
  "--last-failed",
  "--last-failed-file",
  "--ui",
  "--ui-host",
  "--ui-port",
  "--debug",
] as const;

// Unlike boolean flags, these may consume one argument. --project takes several.
const VALUE_TAKING_ARGS = new Set([
  "--add-reporter",
  "--browser",
  "-c",
  "--config",
  "--global-timeout",
  "-g",
  "--grep",
  "-G",
  "--grep-invert",
  "--only-changed",
  "--output",
  "--run-agents",
  "--test-list",
  "--test-list-invert",
  "--timeout",
  "--trace",
  "--tsconfig",
  "-u",
  "--update-snapshots",
  "--update-source-method",
]);

export function parseProjectFilters(args: readonly string[]): RegExp[] {
  const reserved = args.find(isReservedArg);
  if (reserved !== undefined) {
    throw new Error(
      `Cannot forward ${reserved} to \`playwright test\`: the leak finder ` +
        `controls ${RESERVED_ARGS.join(", ")} itself, and overriding them ` +
        "would break the search. Remove it from your arguments.",
    );
  }

  const projects: string[] = [];
  let option = "";
  for (const arg of args) {
    if (arg.startsWith("-")) {
      option = arg;
      if (arg.startsWith("--project=")) projects.push(arg.slice("--project=".length));
    } else if (option === "--project") {
      projects.push(arg);
    } else if (VALUE_TAKING_ARGS.has(option)) {
      option = "";
    } else {
      throw new Error(
        `Cannot forward the test filter "${arg}" to \`playwright test\`: ` +
          "it would be combined with the filters the search uses, widening " +
          "every step instead of narrowing it. Use --grep or --project instead.",
      );
    }
  }
  return projects.map(projectPattern);
}

export function buildRunArgs(options: RunOptions): string[] {
  const args = ["--workers=1"];
  if (options.stopOnFirstFailure) args.push("--max-failures=1");
  // Playwright checks each positional filter against every declaration. A
  // single file regex for a shared line is equivalent to OR-ing its filters.
  const byLine = new Map<number, Set<string>>();
  for (const { file, line } of options.locations ?? []) {
    // A line break prevents Playwright from parsing /regex/:line. Keep such
    // a path separate so it cannot invalidate another file's filter.
    if (/[\r\n\u2028\u2029]/u.test(file)) {
      args.push(locationFilter([formatFilePattern(file)], line));
      continue;
    }
    const files = byLine.get(line);
    if (files) files.add(file);
    else byLine.set(line, new Set([file]));
  }
  for (const [line, files] of byLine) {
    let group: string[] = [];
    let length = 0;
    for (const file of files) {
      const pattern = formatFilePattern(file);
      // Bound individual arguments as well as the size of each compiled regex.
      if (length && length + pattern.length > 2_048) {
        args.push(locationFilter(group, line));
        group = [];
        length = 0;
      }
      group.push(pattern);
      length += pattern.length + 1;
    }
    args.push(locationFilter(group, line));
  }
  return args;
}

function isReservedArg(arg: string): boolean {
  // Short flags carry their value attached (`-j2`) or clustered (`-xj2`).
  return RESERVED_ARGS.some((flag) =>
    flag.length === 2
      ? arg.startsWith(flag)
      : arg === flag || arg.startsWith(`${flag}=`),
  );
}

function projectPattern(name: string): RegExp {
  const pattern = name.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${pattern}$`, "iu");
}

function locationFilter(patterns: string[], line: number): string {
  const files = patterns.length === 1 ? patterns[0] : `(?:${patterns.join("|")})`;
  return `/[/\\\\]${files}$/:${line}`;
}

// Playwright treats file:line arguments as regexes against absolute paths.
function formatFilePattern(file: string): string {
  const segments = file.split(/[/\\]/u);
  // Resolved paths no longer contain the leading ".." of an external testDir.
  while (segments[0] === "..") {
    segments.shift();
  }
  return segments.map(escapeRegex).join("[/\\\\]");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
