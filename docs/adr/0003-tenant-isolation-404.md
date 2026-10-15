# ADR 0003: Tenant isolation with membership guard and 404 for outsiders

## Status
Accepted

## Context
FlowForge is multi-tenant. A user must never read or change another workspace's
data, and must not be able to learn which workspace ids exist.

## Decision
- Every workspace-scoped route uses `JwtAuthGuard` followed by
  `WorkspaceAccessGuard`, which checks membership on every request.
- A non-member receives **404** `WORKSPACE_NOT_FOUND`, identical to the answer for
  a workspace that does not exist. A member with too low a role receives **403**
  `WORKSPACE_FORBIDDEN`.
- Roles are ranked `VIEWER < EDITOR < OWNER`. A route without `@RequireRole`
  requires at least `VIEWER`, so forgetting the decorator never opens a route.
- Guards run before validation pipes, so outsiders learn nothing from error details.
- `OWNER` cannot be granted through the API; ownership transfer will be its own flow.

## Consequences
- End-to-end tests assert isolation: foreign and nonexistent workspaces are
  indistinguishable, and blocked requests leave no trace.
- One extra query per request for the membership check. It can be cached in Redis
  later, with an explicit invalidation strategy.
- `POST /members` lets an owner learn whether an email has an account. Mitigations:
  rate limiting, or an email-invitation flow.
