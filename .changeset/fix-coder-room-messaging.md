---
"@electric-agent/studio": patch
---

Fix coder agent not communicating in room: embed room context in initial prompt instead of relying on queued discovery prompt, inject coder role skill, log agent prompts, and align @room placement instructions across all skills.
