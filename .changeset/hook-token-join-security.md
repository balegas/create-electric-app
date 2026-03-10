---
"@electric-agent/studio": minor
---

Security: authenticate hook-event endpoint with scoped HMAC tokens and require id+code for room joins

- Hook-event endpoint now requires a purpose-scoped HMAC token (`deriveHookToken`) instead of being auth-exempt
- Hook token is derived with a `hook:` prefix so it cannot be used as a session token
- Sprites and Docker containers receive only the scoped hook token, not `DS_SECRET`
- Room/shared-session join endpoints now require both the session ID and invite code, preventing brute-force of short codes
- Join token format changed to `id:code` for copy/paste workflows
