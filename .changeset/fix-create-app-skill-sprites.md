---
"@electric-agent/studio": patch
---

fix: write create-app skill to sandbox after scaffold

The npm-published @electric-agent/agent package may not include the .claude/skills/create-app/ directory, causing Claude Code to fail with "Unknown skill: create-app" when started in sprites. The server now writes the skill file from the local template after scaffold setup.
