---
"@electric-agent/studio": minor
"@electric-agent/agent": patch
---

Add room messaging protocol with gated questions to CLAUDE.md for all agents.

- Embed the room messaging protocol (including `@room GATE:` for human input) directly in generated CLAUDE.md via a new `roomParticipant` option
- Export `ROOM_MESSAGING_SECTION` for appending to existing CLAUDE.md files when agents join rooms mid-session
- Update create-app skill to use `@room GATE:` for clarification when in a room context (falls back to AskUserQuestion in solo sessions)
- Replace inline room-messaging reference strings in server.ts with the shared constant
