---
"@electric-agent/studio": minor
---

Security: proxy Durable Streams so DS_SECRET never leaves the server process.

- Remove `getStreamEnvVars()` from public API (DS_SECRET was exposed to callers)
- Remove `streamUrl`/`streamHeaders` from `SessionBridge` interface and bridge class fields (credentials no longer stored as class state)
- Add `/api/sessions/:id/stream/append` proxy endpoint with Content-Type, size limit (64KB), and JSON validation
- Bridges pass DS credentials only to DurableStream constructor — no field retention
