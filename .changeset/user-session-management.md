---
"@electric-agent/protocol": minor
"@electric-agent/studio": minor
---

Add private sessions with room-based sharing, sidebar UX improvements, and manual OAuth override

- Sessions are now stored in browser localStorage instead of a global Durable Streams registry, making them private per browser
- Room-based sharing via invite codes: create rooms, link sessions, and view linked sessions together
- Sidebar: joined rooms now appear before Create/Join action buttons
- Shared session header: room participant avatars positioned before share controls
- Settings: new OAuth Token field for manually overriding Claude authentication (takes priority over macOS Keychain)
