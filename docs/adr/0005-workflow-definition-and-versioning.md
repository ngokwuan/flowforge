# ADR 0005: Workflow definitions, execution snapshots and optimistic locking

## Status
Accepted

## Context
A workflow is a graph edited by several people and executed many times. Runs must
stay correct while the workflow keeps changing, concurrent edits must not silently
overwrite each other, and an invalid graph must never reach the engine.

## Decision
- **Definition** is JSON (`nodes`, `edges`) in a `jsonb` column. One Zod schema in
  `packages/shared` validates structure and graph rules (exactly one trigger, no
  cycles, no unreachable nodes, edges point to real nodes). The API, worker and
  editor all use it. Graph problems are reported as validation errors with a path
  to the offending node or edge.
- **Execution snapshot:** an `Execution` stores a copy of the definition and the
  workflow version it was created from. Editing the workflow never changes a run
  that is queued, running or finished.
- **Optimistic locking:** `Workflow.version` increments on every save. An update
  names the version it read and applies only if the row is still at that version,
  in a single atomic statement. The loser gets 409 `WORKFLOW_VERSION_CONFLICT`
  with the current version.
- **Idempotency:** `unique(workflowId, idempotencyKey)` on `Execution` lets a
  duplicated webhook delivery create at most one run, enforced by the database.
- **Steps as rows:** `ExecutionStep` is a table (unique per execution and node),
  so steps can be queried, retried and resumed individually.
- **Roles:** VIEWER reads, EDITOR creates and edits, OWNER deletes. Every query
  filters by the workspace id taken from the verified membership.

## Consequences
- Run history is exact, at the cost of storing a definition copy per run.
- Deleting a workflow deletes its executions (cascade). Soft delete is the
  alternative if history must outlive a workflow.
- Lists use cursor pagination ordered by `updatedAt` then `id`; an item edited
  while a client pages can move between pages.
- Node `type` and `config` are checked only structurally for now. Validation
  against each node's own schema arrives with `packages/node-sdk`.
- Request bodies above the 100 KB parser default are rejected before reaching the
  controller; the error filter does not yet map that case to a 413.
