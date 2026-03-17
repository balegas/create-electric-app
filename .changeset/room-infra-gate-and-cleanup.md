---
"@electric-agent/studio": minor
"@electric-agent/agent": patch
---

Room improvements: move infra gate to room page, cascade-delete agents, persist sessions, markdown messages.

- Infrastructure configuration is now a room-level concern — the gate renders inline in the room page instead of requiring navigation to a coder session
- Deleting a room cascades to delete all associated agent sessions
- Room-session mappings are persisted to durable stream so rooms survive server restarts (interrupted rooms show correct status)
- Room messages render with markdown formatting (code blocks, headings, lists)
- Pre-create sprite checkpoints in CI after deploy to eliminate slow bootstrap
- Fix plan approval regression: revert clarification to use AskUserQuestion instead of non-blocking @room GATE
- Fix infra gate race condition: create gate before async flow so it's visible immediately
- Gate resolution broadcasts summary to room as system message
