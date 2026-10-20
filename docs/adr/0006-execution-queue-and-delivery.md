# ADR 0006: Creating executions and delivering them to the worker

## Status
Accepted

## Context
Starting a workflow must be fast, must not run it twice when a client retries, and
must not lose a run when Redis or the API process fails between "saved" and
"queued". A database commit and a queue publish cannot be one transaction.

## Decision
- `POST /workspaces/:ws/workflows/:id/executions` inserts an `Execution` row with
  status `QUEUED` (including the definition snapshot), then publishes a BullMQ job.
  It answers **202 Accepted**: the run is recorded, not finished.
- The **row is the source of truth** and acts as the outbox. The job carries only
  `executionId` and `workspaceId`; the worker loads everything else from the database.
- The job id equals the execution id, so publishing the same execution twice does
  not create two jobs.
- If publishing fails or times out (3 s), the request still succeeds and the row
  stays `QUEUED`. `republishStaleQueued()` republishes rows that stayed `QUEUED`
  too long; the worker will run it periodically.
- **Idempotency:** an optional `Idempotency-Key` header is backed by
  `unique(workflowId, idempotencyKey)`. Concurrent requests with one key produce
  one execution; the others return it.
- Redis keys use a per-environment prefix, so tests never feed a development worker.

## Consequences
- At-least-once delivery. The worker must treat a job as idempotent and move the
  row from `QUEUED` to `RUNNING` atomically, so a duplicate job does not run twice.
- A Redis outage delays runs instead of failing requests, but clients see 202 for
  work that has not been published yet.
- The republish sweep scans `status = QUEUED` rows; it needs an index on
  `(status, queuedAt)` once volume grows.
- Job retention is short on purpose; run history lives in the database.
