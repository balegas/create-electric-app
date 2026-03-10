---
"@electric-agent/agent": minor
"@electric-agent/studio": patch
---

Bundle the room-messaging communication skill in the agent template so it ships with every scaffolded project. The skill is now room-aware: agents only use `@room`/`@name` messaging when they detect they are in a multi-agent room (via the discovery prompt), and work normally in standalone mode without attempting to broadcast. The server no longer injects the skill at join time.
