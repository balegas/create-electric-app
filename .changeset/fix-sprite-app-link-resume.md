---
"@electric-agent/studio": patch
---

Fix "Open App" link not showing on session resume for Sprites. The link now activates after the first "done" log message using the session's previewUrl as fallback, instead of relying solely on the app_status event which often lacks port/previewUrl on replay.
