---
"@electric-agent/studio": minor
"@electric-agent/protocol": minor
---

Unify shared sessions and agent rooms into a single "Rooms" concept. Remove all legacy shared-session code: `/api/shared-sessions/*` routes, SharedSessionPage, SharedSessionHeader, useSharedSession hook, shared-session-store, presence ping system, and related CSS. Rename `SharedSessionEvent` to `RoomEvent` and `shared_session_created` to `room_created` in the protocol. The sidebar now has one "Rooms" section. Room headers display the room name and a copy-invite-code button.
