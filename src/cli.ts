#!/usr/bin/env node
import { HELP, parseCliArgs } from "./args";
import { LeakFinder, type LeakFinderReport } from "./leak-finder";
import { PlaywrightInterruptedError, PlaywrightRunner } from "./playwright";
import { FileStateStore } from "./state";

const EXIT_CODE = {
  OK: 0,
  ERROR: 1,
  NO_LEAK_FOUND: 2,
} as const;

async function main(): Promise<number> {
  const { command, auto, playwrightArgs } = parseCliArgs(process.argv.slice(2));
  const store = new FileStateStore();

  switch (command) {
    case "help":
      console.log(HELP);
      return EXIT_CODE.OK;
    case "reset":
      await store.clear();
      console.log("Leak finder state cleared.");
      return EXIT_CODE.OK;
    case "status":
      await printStatus(store);
      return EXIT_CODE.OK;
    case "run":
      return runSearch(store, playwrightArgs, auto);
  }
}

async function printStatus(store: FileStateStore): Promise<void> {
  const state = await store.load();
  if (state.target === null) {
    console.log("No active search. Run playwright-leak-finder to start one.");
    return;
  }
  console.log(`Current target is: ${state.target}\nNext step: ${state.steps}`);
}

async function runSearch(
  store: FileStateStore,
  playwrightArgs: string[],
  auto: boolean,
): Promise<number> {
  const finder = new LeakFinder(new PlaywrightRunner(), store);
  let report: LeakFinderReport;
  do {
    report = await finder.run(playwrightArgs);
    printSummary(report);
  } while (auto && !report.done);

  const finishedWithoutLeak = report.done && report.leakCandidate === null;
  return finishedWithoutLeak ? EXIT_CODE.NO_LEAK_FOUND : EXIT_CODE.OK;
}

function printSummary({ lines }: LeakFinderReport): void {
  const rule = "=".repeat(25);
  console.log(`\n${rule} Leak finder ${rule}`);
  for (const line of lines) {
    console.log(line);
  }
}

function handleFatalError(error: unknown): void {
  if (error instanceof PlaywrightInterruptedError) {
    // PlaywrightRunner has already forwarded the signal to its child and
    // removed the temporary report. Re-raise only for the CLI so exported
    // library consumers with their own handler see the signal exactly once.
    process.kill(process.pid, error.signal);
    return;
  }
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = EXIT_CODE.ERROR;
}

main().then((code) => {
  process.exitCode = code;
}, handleFatalError);
