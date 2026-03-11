---
"@electric-agent/studio": minor
---

Unify shared sessions and agent rooms into a single "Rooms" concept. The sidebar now has one "Rooms" section instead of separate "Rooms" and "Agent Rooms" sections. Room headers display the room name and a copy-invite-code button. Legacy `/shared/:id/:code` URLs redirect to `/room/:id`. Client-side localStorage stores are merged with automatic migration of existing entries.
