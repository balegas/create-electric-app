---
"@electric-agent/protocol": minor
"@electric-agent/studio": minor
---

Replace `app_ready` event with `app_status` event carrying status, port, and previewUrl. Remove 10-second polling loop for app status in the UI — preview button now driven entirely by SSE events.
