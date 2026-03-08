---
"@electric-agent/protocol": minor
"@electric-agent/studio": minor
---

Add agent-to-agent communication primitive via room messaging.

New protocol events: `agent_message`, `room_closed`, `outbound_message_gate`, `outbound_message_gate_resolved`.

New `RoomRouter` class routes messages between agents through durable streams. Supports broadcast and direct messaging, optional per-agent gating for human approval, automatic discovery on join, turn-based conversation with configurable max rounds, and `DONE:`/`GATE:` conventions for signaling completion or requesting human input.

New server API routes: `POST /api/rooms`, `POST /api/rooms/:id/agents`, `POST /api/rooms/:id/messages`, `GET /api/rooms/:id/events`, `GET /api/rooms/:id`, `POST /api/rooms/:id/close`.

New skill file `.claude/skills/room-messaging/SKILL.md` teaches agents the `@room` messaging protocol.
