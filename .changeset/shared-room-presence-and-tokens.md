---
"@electric-agent/studio": minor
---

Fix shared room linked session visibility and presence tracking.

- Add session token relay endpoint so room participants can view linked session streams
- Replace stream-based participant tracking with heartbeat-based presence (ping every 30s, stale after 90s)
- Fix sidebar room reordering on click
