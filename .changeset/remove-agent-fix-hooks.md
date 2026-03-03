---
"@electric-agent/protocol": minor
"@electric-agent/studio": minor
"@electric-agent/agent": minor
---

Remove electric-agent mode, fix AskUserQuestion hook blocking, and UI improvements

- Remove the custom Agent SDK pipeline (Clarifier, Planner, Coder) — only Claude Code bridge mode remains
- Fix AskUserQuestion hooks in Docker and Sprites bridges: correct nested hook format, comma-separated --allowedTools flag, base64 file encoding
- Fix Sprites bridge race condition: await hook installation before spawning Claude Code
- Fix Sprites bridge studioUrl config: resolve server URL for remote sandboxes via FLY_APP_NAME
- Fix local hook setup script (/api/hooks/setup) to use correct nested hook format
- Add "Other..." free text input option to AskUserQuestion gate UI
- Fix gate selection display: show resolved summary for plan and clarification gates
- UI fixes: markdown heading sizes, sidebar delete button, tool execution display
