# playwright-leak-finder

You have a [Playwright](https://playwright.dev) test that passes when executed
alone but fails when running the whole suite. What's happening? Most likely
some earlier test leaks state (globals, storage, a shared server, ...) that
breaks it. But which one, when there are dozens of earlier tests?

This tool finds the culprit by doing a
[binary search](https://en.wikipedia.org/wiki/Binary_search_algorithm)
(*à la* [`git bisect`](https://git-scm.com/docs/git-bisect)) over the tests
collected before the failing one.

The first run executes the suite until a test fails and records it as the
**target**. Each following run executes half of the tests that previously ran
before the target, plus the target itself. If the target still fails, the leak
is in that half, so it gets bisected again; if it passes, the search moves to
the other half — until a single leaking test remains.

## Installation

```
npm install --save-dev playwright-leak-finder
```

`@playwright/test` >= 1.40 must be installed in your project.

## Usage

Consider [`demo/`](demo/): a task board app with a browser suite where one
test imports three tasks and forgets to delete them, which makes a later test
fail. The demo lives in this repository, not in the npm package, so clone the
repo to follow along (see [`demo/README.md`](demo/README.md) for its setup):

```
$ cd demo && npx playwright test

  ✓ tests/board.spec.ts:10:1 › adds a task from the form
  ✓ tests/board.spec.ts:20:1 › marks a task as done
  ✓ tests/import.spec.ts:5:1 › imports a batch of tasks
  ✓ tests/import.spec.ts:20:1 › rejects a task without a title
  ✘ tests/reports.spec.ts:3:1 › reports an empty board
  ✓ tests/reports.spec.ts:12:1 › counts the tasks it creates
```

Run the leak finder instead. Any argument you pass is forwarded to
`playwright test` — `--config`, `--project`, `--grep` and friends — except
for two kinds it rejects rather than silently ignoring:

- **Flags the search sets itself**: `--reporter`, `--workers`/`-j`,
  `--max-failures`/`-x`, `--list`, `--retries`, `--shard`, `--repeat-each`,
  `--ui`, `--debug`. Tests always run with `--workers=1` so execution order is
  deterministic, and the JSON reporter is how results are read back.
- **Bare test filters** (`reports.spec.ts`, `reports.spec.ts:12`). Playwright ORs
  those with the filters the search uses, so one would widen every step
  instead of narrowing it. Use `--grep` or `--project` instead.

The first run checks that the failing test still fails when run alone — if it
does, there is no leak to hunt and the search stops there. Otherwise it sets
the target and stops:

```
$ npx playwright-leak-finder

  ✓ tests/board.spec.ts:10:1 › adds a task from the form
  ✓ tests/board.spec.ts:20:1 › marks a task as done
  ✓ tests/import.spec.ts:5:1 › imports a batch of tasks
  ✓ tests/import.spec.ts:20:1 › rejects a task without a title
  ✘ tests/reports.spec.ts:3:1 › reports an empty board

========================= Leak finder =========================
Target set to: reports.spec.ts › reports an empty board
Suspects remaining: 4
Run the same command again to bisect the tests before the target.
```

The second run executes the first half of the tests that ran before the
target (the two `board.spec.ts` tests), plus the target. Here the target
passes, so the leak must be in the other half — the two `import.spec.ts`
tests remain suspects:

```
$ npx playwright-leak-finder

  ✓ tests/board.spec.ts:10:1 › adds a task from the form
  ✓ tests/board.spec.ts:20:1 › marks a task as done
  ✓ tests/reports.spec.ts:3:1 › reports an empty board

========================= Leak finder =========================
We reached the target and nothing failed. Let's bisect the other half.
Suspects remaining: 2
Current target is: reports.spec.ts › reports an empty board
```

The third run bisects the remaining suspects down to one:

```
$ npx playwright-leak-finder

  ✓ tests/import.spec.ts:5:1 › imports a batch of tasks
  ✘ tests/reports.spec.ts:3:1 › reports an empty board

========================= Leak finder =========================
We found a leak!
Leak found in: import.spec.ts › imports a batch of tasks
This search is finished but its state is still saved: run --reset before starting another one.
```

And there it is: the batch import was the problematic test we were looking
for — it never deletes the tasks it creates.

There is no human verdict to give between steps — the tests themselves decide
pass or fail — so you can also let it run the whole search in one go:

```
$ npx playwright-leak-finder --auto
```

The search state outlives the answer, so running the command again would just
repeat the last step against a stale target. Clear it before hunting the next
leak:

```
$ npx playwright-leak-finder --reset

Leak finder state cleared.
```

### What it cannot find

The search assumes tests run in one deterministic order and that the failure
reproduces every time. Where that does not hold, it says so rather than
guessing:

- **Leaks that need two or more earlier tests together.** Bisection can only
  pin a single test, so it reports that it cannot narrow further.
- **Multi-project configs.** Every spec runs once per project, so there is no
  single order to bisect — pass `--project=<name>` to search one at a time.
- **A genuinely flaky target.** If the target fails for its own reasons rather
  than because of a leak, the first run catches it and stops. But a target
  that fails intermittently will send the search down the wrong half.
- **Spec files edited mid-search.** The saved snapshot addresses tests by
  `file:line`, so if lines shift the step is reported as inconclusive; run
  `--reset` and start over.

### CLI options

| Option | Description |
| --- | --- |
| `--auto` | Keep running bisection steps until the search finishes |
| `--reset` | Clear the saved search state and exit |
| `--status` | Print the saved search state and exit |
| `-h`, `--help` | Show help |

Everything else is forwarded to `playwright test`. Search progress is stored
in `.playwright-leak-finder/state.json` (add it to your `.gitignore`).

The exit code distinguishes the outcomes, so the CLI is scriptable:

| Code | Meaning |
| --- | --- |
| 0 | A leak was found, or a step completed and the search can continue |
| 1 | Error: bad arguments, or Playwright could not run |
| 2 | The search finished without finding a leak |

## Programmatic API

```ts
import { FileStateStore, LeakFinder, PlaywrightRunner } from "playwright-leak-finder";

const finder = new LeakFinder(new PlaywrightRunner(), new FileStateStore());
const report = await finder.run(["--grep", "@slow"]);

console.log(report.lines.join("\n"));
if (report.leakCandidate) {
  console.log(`Culprit: ${report.leakCandidate}`);
}
```

`LeakFinder` only depends on the `TestRunner` and `StateStore` interfaces, so
both can be swapped out (e.g. with in-memory fakes in tests).

## Development

```
npm install
npm run typecheck
npm test
npm run build
```

The unit and end-to-end tests run against a browserless fixture suite in
[`tests/fixtures/leaky-suite/`](tests/fixtures/leaky-suite/). The browser demo
in [`demo/`](demo/) is a separate package that links this one with `file:..`;
build here before installing it, and it is not part of the published package.
