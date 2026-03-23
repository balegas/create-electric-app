# TUI (Terminal User Interface) Design Spec

## Overview

Add a terminal-based client (`@electric-agent/tui`) to the create-electric-app monorepo that connects to the existing studio server via HTTP/SSE API. Full feature parity with the web UI minus file explorer and cost tracking (which are also removed from the web UI in this patch).

## Decisions

- **Framework:** Ink (React for CLI)
- **Architecture:** Thin client — shared API layer extracted to `@electric-agent/protocol`
- **Layout:** Full-width console with bottom tab bar
- **Room navigation:** Peek/split toggle — room chat primary, agent consoles on-demand
- **Gates:** Status bar alert (non-blocking), press `G` to open overlay
- **Settings:** Dedicated full-screen form via `S` hotkey
- **Package location:** `packages/tui` as `@electric-agent/tui`
- **Config:** `~/.electric-agent/config.json` for credentials and server URL

## Package Structure

```
packages/tui/
  package.json          # @electric-agent/tui
  tsconfig.json
  src/
    index.tsx           # Entry point — parse args, Ink render(<App>)
    app.tsx             # Root component — tab manager, keybindings, gate alert
    components/
      TabBar.tsx        # Bottom tab bar with [1-9] [N] [S] [G] [Q] keys
      Console.tsx       # Scrollable event feed with log/tool/assistant entries
      ConsoleEntry.tsx  # Single event line (log, tool call, assistant message)
      PromptInput.tsx   # Text input with Enter to submit
      GateAlert.tsx     # Status bar line: "⚠ GATE: ... — press G"
      GateOverlay.tsx   # Modal overlay for gate response (infra config, questions)
      PeekPanel.tsx     # Inline agent console peek in room view
      ParticipantBar.tsx # Row of participant status badges in rooms
    screens/
      HomeScreen.tsx    # Prompt input, join room, recent sessions/rooms list
      SessionScreen.tsx # Console + input + gate alert for a session
      RoomScreen.tsx    # Room chat + participant bar + peek support
      SettingsScreen.tsx # Credential form fields
    hooks/
      useSessionStream.ts  # SSE consumer for EngineEvent, returns console entries
      useRoomStream.ts     # SSE consumer for RoomEvent, returns messages
      useConfig.ts         # Read/write ~/.electric-agent/config.json
      useGate.ts           # Gate state management across sessions
      useKeybindings.ts    # Global hotkey handler
    lib/
      config.ts         # Config file read/write logic
      formatting.ts     # Log level colors, timestamp formatting, text truncation
```

## Shared API Client Refactor

Extract HTTP/SSE logic from `packages/studio/client/src/lib/api.ts` into `@electric-agent/protocol`:

```
packages/protocol/src/
  client.ts             # ElectricAgentClient class
  index.ts              # Re-export types + client
```

`ElectricAgentClient` class:
- Constructor: `{ baseUrl, credentials?, participant? }`
- Session: `createSession()`, `getSession()`, `iterateSession()`, `interruptSession()`, `deleteSession()`, `respondToGate()`, `sessionEvents()` (async iterable)
- Room: `createAppRoom()`, `createRoom()`, `getRoomState()`, `addAgentToRoom()`, `sendRoomMessage()`, `roomEvents()` (async iterable)
- Config: `getConfig()`

The web UI's `api.ts` is then refactored to import from `@electric-agent/protocol/client`.

## Screens

### Home Screen
- Large text input for app description
- `[Enter]` creates session, `[J]` join room by code, `[R]` create multi-agent room
- Recent sessions/rooms list with status indicators
- Selecting a recent item opens it in a new tab

### Session Console
- Scrollable feed of EngineEvent entries
- Log entries color-coded by level (system=gray, build=blue, task=green, error=red, etc.)
- Tool calls collapsed to single line: `[tool] tool_name arg_summary [+]` — expand with Enter
- Assistant messages rendered with basic markdown (bold, code blocks)
- Text input at bottom for iterate messages
- Status line shows session state: `[running]`, `[complete]`, `[needs input]`

### Room Chat
- Chronological feed of RoomEvent `agent_message` entries
- Format: `sender → recipient: message` (or `sender → room:` for broadcasts)
- Participant bar showing each agent's name and status badge
- `[P]` hotkey opens peek selector — pick agent, inline peek panel appears
- Peek panel shows last N lines of that agent's console, `[Esc]` dismisses
- Text input sends messages to room

### Gate Response
- Non-blocking: status bar shows `⚠ GATE: <summary> — press G`
- Pressing `G` opens overlay with gate details
- Infra config gate: numbered choices for hosting + GitHub repo
- User question gate: displays question with options or free text
- Outbound message gate: shows message body, `[A]pprove / [E]dit / [D]rop`
- `[Esc]` dismisses overlay without responding

### Settings
- Form fields: Server URL, API Key, OAuth Token, GitHub PAT
- Credentials masked by default (show `••••1234`), `[Enter]` to edit
- `[Tab]` to navigate fields
- `[Esc]` to go back (auto-saves)
- Shows connection status indicator

## Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `1-9` | Global | Switch to tab N |
| `N` | Global | New session (opens Home if not there, focuses prompt) |
| `S` | Global | Open/toggle Settings screen |
| `G` | Session/Room | Open gate overlay (if gate pending) |
| `J` | Home | Join room by invite code |
| `R` | Home | Create multi-agent room |
| `P` | Room | Open peek panel (select agent) |
| `Q` | Global | Quit (with confirmation if sessions running) |
| `Esc` | Overlay/Peek | Dismiss overlay or peek panel |
| `Enter` | Input | Submit message |
| `Tab` | Settings | Next field |

## SSE Handling

Use `eventsource-parser` for Node.js SSE consumption (no `EventSource` API in Node). The shared client exposes async iterables:

```ts
for await (const event of client.sessionEvents(sessionId)) {
  // Process EngineEvent
}
```

Each active session/room maintains its own SSE connection. Background tabs keep connections alive and buffer events.

## Config File

Path: `~/.electric-agent/config.json`

```json
{
  "server": "http://localhost:4400",
  "credentials": {
    "apiKey": "sk-ant-...",
    "oauthToken": null,
    "githubToken": "ghp_..."
  },
  "participant": {
    "id": "uuid-v4",
    "displayName": "user"
  }
}
```

CLI flags override config values. Created on first settings save.

## Web UI Cleanup

Remove from web UI (client-side only, server endpoints remain):
- File explorer/browser components and their usage
- Cost tracking display (`totalCostUsd`) from session cards and session page
- `budget_exceeded` event handling in console UI

## CLI Interface

```
electric-tui [options]

Options:
  --server <url>    Server URL (default: http://localhost:4400)
  --config <path>   Config file (default: ~/.electric-agent/config.json)
  --version         Show version
  --help            Show help
```

## Dependencies

New dependencies for `packages/tui`:
- `ink` ^5 — React renderer for CLI
- `react` ^18 — React (peer of Ink)
- `ink-text-input` — text input component
- `ink-spinner` — loading spinners
- `ink-select-input` — selection lists (for gate choices)
- `eventsource-parser` — SSE stream parsing in Node
- `meow` or `yargs` — CLI arg parsing
- `@electric-agent/protocol` — shared types + API client
