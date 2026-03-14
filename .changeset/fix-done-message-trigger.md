---
"@electric-agent/studio": patch
---

Move DONE message responsibility to room-messaging skill instead of auto-generating it in server onComplete handler. The server no longer emits `@room DONE:` when the coder session exits successfully — only the coder agent itself should send DONE after verifying the app is ready.
