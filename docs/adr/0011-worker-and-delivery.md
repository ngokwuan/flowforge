# ADR 0011: The worker, and how a job reaches the engine

## Status
Accepted

## Context
The API stores an execution and publishes a job. The worker has to take that job,
run the workflow, and survive duplicates, bad jobs, lost jobs and shutdowns,
without the engine knowing anything about Redis or the database.

## Decision
- **The worker is a thin shell.** `ExecutionsWorker` reads BullMQ jobs and calls
  `runExecution` from `packages/engine`. `PrismaExecutionStore` implements the
  engine's `ExecutionStore` with the database.
- **Claiming is one SQL statement.** `UPDATE ... WHERE status = 'QUEUED'` moves an
  execution to RUNNING; whoever gets one affected row runs it. A job delivered
  twice, or taken by two workers, runs the workflow once. A test fires ten
  concurrent claims at the real database and expects exactly one winner.
- **Finishing is conditional too.** `finish` only changes a RUNNING execution, so a
  late call cannot overwrite a final state.
- **Bad jobs fail alone.** Job data is validated before the engine is called; a
  malformed job is marked failed and the worker keeps going.
- **Lost jobs are recovered from the database.** `StaleSweeper` republishes
  executions that stayed QUEUED beyond `STALE_AFTER_MS`. Before adding a job it
  removes a *failed* job with the same id, because BullMQ ignores `add` while any
  job with that id still exists, and failed jobs are retained for days.
- **Graceful shutdown.** On SIGTERM the worker stops taking jobs and waits for the
  running ones; after `SHUTDOWN_GRACE_MS` it cancels them so the process can exit.
- **The worker has its own Prisma client**, generated from the same schema by a
  second generator (ESM, because the worker is an ES module). One schema, one
  migration history, no code shared between the apps' source trees.
- **Tests use real services.** The store and the full path (queue, engine,
  database, sweeper) are tested against PostgreSQL and Redis.

## Consequences
- An execution whose worker dies while RUNNING stays RUNNING: nothing detects it
  yet. This needs a heartbeat and a "resume from the failed step" path, which is
  the next step together with retries and per-node timeouts.
- Shutting down cancels executions that exceed the grace period; they end as
  CANCELLED rather than being resumed.
- The queue options (retention of finished and failed jobs) are duplicated in the
  API and the worker and must be kept in sync.
- `prisma generate` must run before building either app, locally and in CI.
