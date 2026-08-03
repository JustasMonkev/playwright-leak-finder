# Task board demo

A small but real Playwright project to try
[`playwright-leak-finder`](../) on: a dependency-free Node task board
(`server.mjs`) started by Playwright's `webServer`, and a browser suite that
drives it through the UI and its JSON API.

One test leaks: `import.spec.ts › imports a batch of tasks` creates three
tasks and never deletes them, so `reports.spec.ts › reports an empty board`
fails — but only when the suite runs as a whole. That test passes on its own,
which is the situation the leak finder is for.

## Setup

The demo consumes the package from this repository (`"playwright-leak-finder":
"file:.."`), so build it first:

```
npm install && npm run build   # in the repository root
cd demo
npm install
npx playwright install chromium
```

## Run it

The failure, as you would meet it in CI:

```
$ npm test

  ✓ tests/board.spec.ts:10:1 › adds a task from the form
  ✓ tests/board.spec.ts:20:1 › marks a task as done
  ✓ tests/import.spec.ts:5:1 › imports a batch of tasks
  ✓ tests/import.spec.ts:20:1 › rejects a task without a title
  ✘ tests/reports.spec.ts:3:1 › reports an empty board
  ✓ tests/reports.spec.ts:12:1 › counts the tasks it creates
```

The hunt, one bisection step per run:

```
npm run leak          # step by step
npm run leak:auto     # all the steps at once
npm run leak:status   # what the search knows so far
npm run leak:reset    # clear the state before the next hunt
```

Three runs are enough here: the first pins the target, the second clears
`board.spec.ts`, the third names the culprit.

## Fixing the leak

Delete the imported tasks at the end of `imports a batch of tasks` (or in an
`afterEach`), then run `npm run leak:reset && npm test`: the suite passes.

## Poking at the app

```
npm start   # http://localhost:3210
```

`GET|POST /api/tasks`, `PATCH|DELETE /api/tasks/:id`. State is in memory, so
restarting the server empties the board.
