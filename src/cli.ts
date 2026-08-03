#!/usr/bin/env node
import { HELP, parseCliArgs } from "./args";
import { LeakFinder, type LeakFinderReport } from "./leak-finder";
import { PlaywrightRunner } from "./playwright";
import { FileStateStore } from "./state";

async function main(): Promise<number> {
  const { command, auto, playwrightArgs } = parseCliArgs(process.argv.slice(2));
  const store = new FileStateStore();

  switch (command) {
    case "help":
      console.log(HELP);
      return 0;
    case "reset":
      await store.clear();
      console.log("Leak finder state cleared.");
      return 0;
    case "status": {
      const state = await store.load();
      console.log(
        state.target === null
          ? "No active search. Run playwright-leak-finder to start one."
          : `Current target is: ${state.target}\nNext step: ${state.steps}`,
      );
      return 0;
    }
    case "run": {
      const finder = new LeakFinder(new PlaywrightRunner(), store);
      let result: LeakFinderReport;
      do {
        result = await finder.run(playwrightArgs);
        printSummary(result);
      } while (auto && !result.done);
      // 0: leak found or step completed; 2: finished without a leak to blame.
      return result.done && result.leakCandidate === null ? 2 : 0;
    }
  }
}

function printSummary({ lines }: LeakFinderReport): void {
  const rule = "=".repeat(25);
  console.log(`\n${rule} Leak finder ${rule}`);
  for (const line of lines) {
    console.log(line);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
