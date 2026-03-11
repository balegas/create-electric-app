---
"@electric-agent/studio": minor
---

Security: proxy Durable Streams so DS_SECRET never leaves the server process.

- Remove `getStreamEnvVars()` from public API (DS_SECRET was exposed to callers)
- Remove `streamUrl`/`streamHeaders` from `SessionBridge` interface (prevent credential leakage via bridge references)
- Add `/api/sessions/:id/stream/append` proxy endpoint for sandbox stream writes (authenticated via session token)
- Bridges keep DS credentials as private/protected internal state
