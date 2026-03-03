# @electric-agent/protocol

## 1.2.0

### Minor Changes

- e150c6b: Remove electric-agent mode, fix AskUserQuestion hook blocking, and UI improvements

  - Remove the custom Agent SDK pipeline (Clarifier, Planner, Coder) — only Claude Code bridge mode remains
  - Fix AskUserQuestion hooks in Docker and Sprites bridges: correct nested hook format, comma-separated --allowedTools flag, base64 file encoding
  - Fix Sprites bridge race condition: await hook installation before spawning Claude Code
  - Fix Sprites bridge studioUrl config: resolve server URL for remote sandboxes via FLY_APP_NAME
  - Fix local hook setup script (/api/hooks/setup) to use correct nested hook format
  - Add "Other..." free text input option to AskUserQuestion gate UI
  - Fix gate selection display: show resolved summary for plan and clarification gates
  - UI fixes: markdown heading sizes, sidebar delete button, tool execution display

## 1.1.0

### Minor Changes

- a99ba74: Add private sessions with room-based sharing, sidebar UX improvements, and manual OAuth override

  - Sessions are now stored in browser localStorage instead of a global Durable Streams registry, making them private per browser
  - Room-based sharing via invite codes: create rooms, link sessions, and view linked sessions together
  - Sidebar: joined rooms now appear before Create/Join action buttons
  - Shared session header: room participant avatars positioned before share controls
  - Settings: new OAuth Token field for manually overriding Claude authentication (takes priority over macOS Keychain)

## 1.0.0

### Major Changes

- e494542: restructured

### Minor Changes

- 9d0e4a0: monorepo
- a5c4703: Convert to pnpm workspaces monorepo with three packages: protocol, studio, and agent
