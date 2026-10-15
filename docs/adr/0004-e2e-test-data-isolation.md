# ADR 0004: Per-suite data isolation in end-to-end tests

## Status
Accepted

## Context
Jest runs test files in parallel against one shared database. All suites used the
same email suffix and cleaned up with a broad delete, so one suite finishing
removed the users another suite had just created. The failure depended on timing.

## Decision
Each suite generates a random email domain per run and deletes only the data
carrying that domain.

## Consequences
- Suites no longer interfere with each other, and cleanup is safe to run any time.
- Tests still share the development database. A dedicated test database, migrated
  before each run, is the next step if the number of suites grows.
