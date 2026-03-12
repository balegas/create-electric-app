---
"@electric-agent/studio": patch
---

Hide Claude Sessions button and debug section in production mode. Remove natural-language command intercepts (start/stop/restart app, git ops) from the iterate endpoint. Fix room join auth by moving join endpoint to `/api/join-room/:id/:code` outside the protected `/api/rooms/:id/*` namespace.
