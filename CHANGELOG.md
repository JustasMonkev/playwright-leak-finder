# Release notes

## 0.3.1

- Fixed a false leak report when an earlier test enables a failing target that
  skips on its own. The search now starts only when exactly one test matches
  the target's ID, file and line and meets its Playwright expectation. A
  skipped, missing or ambiguous target ends the search with exit code 2.
- With Playwright's `repeatEach` setting, all isolated repeats must meet the
  expectation. A pass in one repeat can no longer hide a skip in another.
- When resuming a search saved by an older version, the CLI verifies the
  target before replaying the saved partition. If the target cannot be
  verified, the saved progress stays intact.
