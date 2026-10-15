# Authentication flow

```mermaid
sequenceDiagram
    participant C as Client
    participant A as API
    participant D as Database

    C->>A: POST /auth/login (email, password)
    A->>D: find user, verify argon2 hash
    A->>D: store HMAC of refresh token (new familyId)
    A-->>C: accessToken in body, refresh token in httpOnly cookie

    C->>A: GET /auth/me (Bearer accessToken)
    A-->>C: user

    Note over C,A: access token expires after 15 minutes
    C->>A: POST /auth/refresh (cookie)
    A->>D: mark old token used, store new one (same familyId)
    A-->>C: new accessToken and new cookie

    Note over C,A: an OLD refresh token is presented again
    C->>A: POST /auth/refresh (old cookie)
    A->>D: token already used, revoke the whole family
    A-->>C: 401 AUTH_REFRESH_REUSED
```

## Endpoints

| Endpoint | Purpose | Auth |
|---|---|---|
| `POST /api/v1/auth/register` | Create account and personal workspace | none |
| `POST /api/v1/auth/login` | Access token in body, refresh token in cookie | none |
| `POST /api/v1/auth/refresh` | Rotate refresh token, new access token | refresh cookie |
| `POST /api/v1/auth/logout` | Revoke the session family, clear cookie | refresh cookie |
| `GET /api/v1/auth/me` | Current user | Bearer access token |

See [ADR 0002](adr/0002-refresh-token-rotation.md) for the reasoning and limits.
