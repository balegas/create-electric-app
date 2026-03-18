---
"@electric-agent/studio": patch
---

Room UI polish and agent communication improvements

- Use link icon + pill style for room link in session header (matches invite code style)
- Always show last 3 tool calls when collapsing action groups
- Coder agent announces phase transitions to room (@room PHASE: ...)
- Creative agent greetings when joining rooms instead of formulaic announcements
- Fix coder not receiving room discovery prompt (couldn't greet or announce phases)
