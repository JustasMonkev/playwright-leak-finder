export type Command = "run" | "reset" | "status" | "help";

export interface CliOptions {
  command: Command;
  /** Keep running steps until the search finishes instead of one per invocation. */
  auto: boolean;
  /** Arguments forwarded verbatim to `playwright test`. */
  playwrightArgs: string[];
}

const COMMANDS: ReadonlyMap<string, Command> = new Map([
  ["--reset", "reset"],
  ["--status", "status"],
  ["--help", "help"],
  ["-h", "help"],
]);

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let command: Command = "run";
  let auto = false;
  const playwrightArgs: string[] = [];
  for (const arg of argv) {
    const matched = COMMANDS.get(arg);
    if (matched) {
      command = matched;
    } else if (arg === "--auto") {
      auto = true;
    } else {
      playwrightArgs.push(arg);
    }
  }
  return { command, auto, playwrightArgs };
}

export const HELP = `playwright-leak-finder — find the test that leaks state into a failing one

Usage:
  playwright-leak-finder [playwright-test-args...]

Run it repeatedly. The first run executes the suite until a test fails and
records it as the "target". Each following run bisects the tests that ran
before the target (git-bisect style) until the leaking test is identified.
Pass --auto to run every step in one go instead.

Once the leak is found the state stays saved: run --reset before hunting
another one.

Options:
  --auto        Keep running bisection steps until the search finishes
  --reset       Clear the saved search state and exit
  --status      Print the saved search state and exit
  -h, --help    Show this help

Exit codes:
  0  A leak was found, or a step completed and the search can continue
  1  Error: bad arguments, or Playwright could not run
  2  The search finished without finding a leak (nothing failed, the target
     fails on its own, or bisection could not narrow it to one test)

Any other argument is forwarded to \`playwright test\` (--config, --project,
--grep, ...), with two exceptions it rejects rather than silently ignores:

  * --reporter, --workers/-j, --max-failures/-x, --list, --retries, --shard,
    --repeat-each, --ui and --debug. The search sets these itself: tests run
    with --workers=1 so execution order is deterministic, and the JSON
    reporter is how results are read back.
  * Bare test filters (a path or a \`file:line\`). Playwright combines those
    with the filters the search uses, so one would widen every step instead
    of narrowing it. Use --grep or --project instead.`;
