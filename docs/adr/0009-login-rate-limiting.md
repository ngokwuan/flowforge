# ADR 0009: Login rate limiting with Redis-backed throttler

## Status

Accepted

## Context

ADR 0002 noted that login is not rate limited. Without throttling, an attacker
can brute-force passwords indefinitely. The API already depends on Redis
(BullMQ queue), so no new infrastructure is required.

## Decision

- Use `@nestjs/throttler` on the `POST /auth/login` and `POST /auth/register`
  endpoints: **5 requests per IP per 60 seconds**.
- Other auth endpoints (`/refresh`, `/logout`, `/me`) are exempt — they are
  already protected by refresh-token validity or a JWT guard.
- Store throttler counters in Redis (`ThrottlerRedisStore`) so limits survive
  API restarts and work correctly behind multiple API replicas.
- The throttler key is the client IP from Express's `req.ip` (set correctly
  when the app sits behind a trusted reverse proxy).

## Consequences

- Brute-force attacks on login are blocked after 5 wrong attempts per minute
  per IP.
- Redis is now a hard dependency for the API (already was for the queue).
- E2E tests that hit login more than 5 times from the same IP must either
  reset the counter between runs or (preferred) run against a test app instance
  that uses an in-memory throttler store.
- A future improvement can add per-account lockout on top of per-IP throttling.
