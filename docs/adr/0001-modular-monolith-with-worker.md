# ADR 0001: Modular monolith with a dedicated worker

## Status
Accepted

## Context
FlowForge has one component with a different load and failure profile
(the execution engine) and several tightly related domains (auth,
workspaces, workflows, credentials). The team is one person.

## Decision
Run `core-api` as a modular NestJS monolith and `engine-worker` as a
separate process. Modules talk through services and events, never through
each other's repositories.

## Consequences
- Low operational cost: two deployables instead of many.
- The worker scales independently and isolates untrusted logic.
- Further splits (for example webhook ingress) stay cheap because module
  boundaries are already enforced.
- Revisit if load tests show another component is a bottleneck.
