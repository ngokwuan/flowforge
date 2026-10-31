# ADR 0007: Node SDK and protection against server-side request forgery

## Status
Accepted

## Context
Every node type must be declared once and used by three consumers: the API (to
validate a workflow when it is saved), the worker (to run it) and the editor (to
draw a form). The HTTP Request node is also the riskiest feature in the product:
it makes the platform call addresses chosen by its users. A tenant could aim it at
`169.254.169.254` (cloud credentials), at `localhost`, or at services inside the
private network.

## Decision
- **One declaration per node** in `packages/node-sdk`: a stable `type` key, a Zod
  `configSchema`, the output `handles`, and an `execute` function. Adding a node is
  one file plus one line in the registry.
- **Validation on save:** the API checks every node's type and config against the
  registry and stores the *parsed* config, so defaults are written explicitly and a
  stored workflow does not change meaning if a default changes later. The engine
  will validate again after resolving `{{ }}` expressions and before `execute`.
- **The editor gets metadata over HTTP** (`GET /node-types`, config as JSON
  Schema). The web app never imports node-sdk, which contains server-only code.
- **`NodeExecutionError.retryable`** tells the engine whether trying again can help
  (5xx, 429, timeouts, connection failures) or cannot (4xx, blocked address, bad
  config).
- **If / Else does no type coercion:** `"42"` does not equal `42`, and ordering
  works only between two numbers or two strings. A surprise here would send a run
  down the wrong branch silently.
- **HTTP node, outgoing requests:**
  - Only `http` and `https`; no credentials in the URL; the client controls
    `Host`, `Content-Length` and similar headers.
  - Literal IP addresses are rejected at save time and again at run time.
  - DNS names are checked inside the connection's own lookup: the addresses
    that were validated are the ones the socket connects to, so there is no
    window for DNS rebinding.
  - Blocked: loopback, private, link-local (including cloud metadata), carrier NAT,
    multicast and reserved ranges, and IPv6 equivalents including IPv4-mapped,
    NAT64 and 6to4 forms. Anything that cannot be parsed is blocked.
  - Redirects are returned, not followed, so a public URL cannot bounce a request
    inward.
  - Timeout 100 ms to 60 s (default 10 s); response size limit 1 MiB by default,
    10 MiB at most; the run's cancellation signal is honored.
  - `allowPrivateNetwork` exists only as a factory option for tests and local
    development, never as a workflow setting.

## Consequences
- The blocked ranges are maintained by hand and must be reviewed periodically.
- Redirects must be handled by the workflow author (the 3xx response is output).
- There is no per-workspace allow-list yet; calling an internal service on purpose
  is not possible. If an egress proxy is introduced, enforce the same rules there.
- Responses are read as UTF-8 text; binary payloads are not supported.
- The guard protects this node only. Any future node that fetches a user-supplied
  URL (webhooks out, AI tools, file import) must reuse `guardedLookup`.
