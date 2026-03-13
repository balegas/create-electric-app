---
"@electric-agent/studio": patch
---

Fix duplicate DONE messages from coder agent. The server's onComplete handler now checks whether the coder already sent its own @room DONE: message before emitting a second one. Also updated UI designer role to ask the user before starting a UI audit when the app is complete.
