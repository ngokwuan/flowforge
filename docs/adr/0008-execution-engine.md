# ADR 0008: Execution engine as a pure library

## Status
Accepted

## Context
The worker must run a workflow reliably: start it exactly once, follow branches,
run independent nodes together, stop cleanly on failure or cancellation, and never
show users internal details. The logic is intricate enough to need fast, thorough
tests, which a design tied to the database and the queue would make slow and flaky.

## Decision
- The engine lives in `packages/engine` and depends only on a small `ExecutionStore`
  interface (claim, init steps, start step, finish step, finish). The worker
  implements it with the database; tests use `InMemoryExecutionStore`.
- **Exactly-once start:** `claim` atomically moves an execution from QUEUED to
  RUNNING and returns nothing otherwise. A job delivered twice, or two workers
  taking the same job, run the workflow once.
- **Scheduling:** a node is ready when all nodes pointing at it are finished. Ready
  nodes run together, up to `maxParallelism` (default 4).
- **Branching:** an edge is active when its source succeeded and, if the edge names
  a handle, the source chose it. A node runs if any incoming edge is active and is
  SKIPPED otherwise; skipping propagates downward, and a node where branches meet
  still runs.
- **Data flow:** a node receives its single active parent's output, or an object
  keyed by node id when several parents are active. The first node receives the
  run's input.
- **Expressions:** `{{ trigger.x }}` and `{{ steps.<id>.output.path }}` are path
  lookups only. They cannot execute code, call functions or reach prototypes. A
  value that is exactly one placeholder keeps its type.
- **Re-validation:** the resolved config is validated against the node's schema
  again before `execute`. A value that only exists at run time (a URL produced by
  an earlier step) never passed the save-time checks, so this is where the SSRF
  guard catches it.
- **Failure:** the first failing node stops scheduling. Nodes already running
  finish; everything not started is SKIPPED; the run is FAILED with
  "<node name>: <message>".
- **Error hygiene:** `NodeExecutionError` messages are shown to users. Any other
  error is logged and replaced by a generic message, because it may contain
  connection strings or stack traces.
- **Cancellation:** an `AbortSignal` reaches every running node; the run ends as
  CANCELLED and unstarted nodes are SKIPPED.
- **Limits:** a node's serialized output is capped (default 1,000,000 bytes).

## Consequences
- Retries, per-node timeouts and resuming from a failed step are not part of this
  version (they are the next step). Every step currently records `attempt` 1.
- All step outputs stay in memory during a run because later nodes may reference
  them. With the output cap and the 100-node limit this is bounded.
- An edge leaving a node with several handles but naming none is treated as active
  for every handle. Save-time validation should require a handle there.
- Join nodes run when any incoming edge is active (OR semantics). Waiting for all
  branches to be active (AND) would be a separate node type.
- Loops are not supported; workflows must be acyclic.
