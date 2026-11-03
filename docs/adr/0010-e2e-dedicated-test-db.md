# ADR 0010: Dedicated test database for E2E suites

## Status

Accepted

## Context

ADR 0004 noted that tests share the development database and that a dedicated
test database is the next step. With more suites the risk of developer data
bleeding into assertions, or vice-versa, grows. There is also no guarantee that
the development schema is in sync with the migrations.

## Decision

- A Jest `globalSetup` script creates a fresh PostgreSQL database named
  `flowforge_test_<timestamp>` before the E2E run starts.
- `prisma migrate deploy` is run against that database, so tests always execute
  against the exact schema described by the committed migrations.
- A Jest `globalTeardown` script terminates any remaining connections and drops
  the database after the run.
- `DATABASE_URL` is overridden in `process.env` so every suite connects to the
  test database automatically.

## Consequences

- E2E tests no longer touch the development database.
- The migration history is exercised on every test run, catching drift early.
- `globalSetup` / `globalTeardown` run in a separate Node.js process from the
  test suites, so env vars must be passed via `process.env` (Jest's `--testEnvironment`
  shares env with worker processes but not with `globalSetup`/`globalTeardown`).
- Each `pnpm test:e2e` run leaves no leftover database if the teardown script
  completes. On CI, any leaked databases can be cleaned by a scheduled script.
- A `pg` (node-postgres) direct connection is used in setup/teardown because
  Prisma cannot `CREATE DATABASE` or `DROP DATABASE`.

