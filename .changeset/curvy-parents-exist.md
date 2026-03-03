---
"@electric-agent/studio": patch
---

Add interrupt endpoint to stop Claude Code without destroying the session. The Stop button now kills the running process but keeps the sandbox alive, allowing follow-up messages via --resume.
