# ADR 0002: Short-lived access tokens and rotating refresh tokens

## Status
Accepted

## Context
Sessions must be revocable, and a stolen token should be detectable. A stateless
JWT alone cannot be revoked before it expires.

## Decision
- **Access token:** JWT (HS256, algorithm pinned on sign and verify), 15 minutes.
  The client keeps it in memory and sends it in the `Authorization` header.
- **Refresh token:** 32 random bytes, not a JWT. Only its HMAC-SHA256 (keyed with
  `JWT_REFRESH_SECRET`) is stored, so a database leak does not hand out usable tokens.
  It travels in an `httpOnly`, `SameSite=Lax` cookie scoped to `/api/v1/auth`.
- **Rotation:** every refresh issues a new token and marks the old one used.
  Tokens from one login share a `familyId`.
- **Reuse detection:** presenting an already-used token revokes the whole family.
- **Atomicity:** the "mark as used" step is a conditional update inside a
  transaction, so of several concurrent refreshes with one token exactly one wins.
- Login always runs one argon2 verification (against a dummy hash for unknown
  emails) and returns one error for both "unknown email" and "wrong password".

## Consequences
- Sessions can be ended server-side, and token theft is detected.
- An access token stays valid for up to 15 minutes after logout (inherent to JWT).
- The `RefreshToken` table grows; expired and revoked rows need a cleanup job.
- Two tabs refreshing at the same moment can log the user out. The frontend must
  allow only one refresh in flight at a time.
- Changing `JWT_REFRESH_SECRET` invalidates every session.
- Login is not rate limited yet (requires Redis).
