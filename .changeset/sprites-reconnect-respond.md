---
"@electric-agent/studio": minor
---

Sprites respond handler: reconnect and wake stopped sprites instead of returning "No active bridge found". Adds specific error messages for each failure mode (sprite deleted, wake failed, sandbox not running, no resume session). Warns at startup when STUDIO_URL is not set for sprites. Uses primary brand color for selected gate options instead of green.
