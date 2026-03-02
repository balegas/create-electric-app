---
"@electric-agent/studio": minor
---

Add stateless HMAC-based session token authentication to protect session-scoped API endpoints. Tokens are derived from DS_SECRET and returned on session creation. Client stores tokens in localStorage and attaches them as Authorization headers (or query params for SSE).
