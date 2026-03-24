---
"@electric-agent/studio": minor
"@electric-agent/protocol": minor
---

TUI/WebUI parity: room-first sessions, shared protocol client, agent observability

- Unify WebUI and TUI on shared ElectricAgentClient from @electric-agent/protocol
- Migrate WebUI SSE from EventSource to protocol client's fetch-based streaming
- Split room message delivery from agent iteration (autoIterate flag + manual deliver API)
- Forward agent assistant_message events to room stream as observability (agent_activity)
- Add custom agent role with skill textarea in Add Agent modal
- Show ask_user_question gates in room timeline
- Add back-to-room link on resolved gates in session view
- Move Settings panel to AppShell (works on all pages including RoomPage)
