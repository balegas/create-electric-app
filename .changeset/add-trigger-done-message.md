---
"@electric-agent/studio": patch
"@electric-agent/agent": patch
---

Always show the Open App button in the UI when a preview URL or port is available, regardless of app completion state. Add a DONE room message to the create-app skill's final phase to signal pipeline completion. Initialize all agents with repo info (URL, branch) via the room router's discovery prompt so they can clone and review code locally.
