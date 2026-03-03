# @electric-agent/studio

## 1.4.0

### Minor Changes

- 43230e0: Support full AskUserQuestion capabilities: multiSelect, multiple questions, and headers

  - Add `AskUserQuestionItem` interface and `questions` field to the `ask_user_question` protocol event
  - Pass through full `questions` array (with `header`, `multiSelect`) from Claude Code stream-json and hook events
  - Rewrite `AskUserQuestionGate` UI to render multiple questions, multiSelect checkboxes, and header chips
  - Extract duplicated `sendGateResponse()` logic from Docker and Sprites bridges into shared `formatGateMessage()` helper
  - Switch gate resolution from single `answer` string to `answers: Record<string, string>` with backwards compat
  - Update SKILL.md Phase 0 to be less prescriptive about clarification format

### Patch Changes

- Updated dependencies [43230e0]
  - @electric-agent/protocol@1.3.0

## 1.3.4

### Patch Changes

- c9d046b: Settings UI: replace two API key fields with single input + key type dropdown, add keychain detection notes. Make collapsible chat messages selectable for copy-paste. Add deploy phase to SKILL.md execution instructions and strengthen dev server instructions to prevent sprite-env services misuse.

## 1.3.3

### Patch Changes

- b9a9542: Add interrupt endpoint to stop Claude Code without destroying the session. The Stop button now kills the running process but keeps the sandbox alive, allowing follow-up messages via --resume.

## 1.3.2

### Patch Changes

- 8d67675: fix: restore TTY mode for Claude Code in sprites (non-TTY produces zero stdout)

## 1.3.1

### Patch Changes

- f28371e: fix: write create-app skill to sandbox after scaffold

  The npm-published @electric-agent/agent package may not include the .claude/skills/create-app/ directory, causing Claude Code to fail with "Unknown skill: create-app" when started in sprites. The server now writes the skill file from the local template after scaffold setup.

- c4bf020: fix: disable TTY mode in sprites bridge so AskUserQuestion gates block properly

  Switching SpriteCommand from `tty: true` to no-TTY mode prevents PTY from merging stdout/stderr and corrupting hook response JSON. This matches the Docker bridge behavior where pipes cleanly separate streams.

## 1.3.0

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

### Patch Changes

- Updated dependencies [e150c6b]
  - @electric-agent/protocol@1.2.0

## 1.2.0

### Minor Changes

- 77b1eef: Add stateless HMAC-based session token authentication to protect session-scoped API endpoints. Tokens are derived from DS_SECRET and returned on session creation. Client stores tokens in localStorage and attaches them as Authorization headers (or query params for SSE).

### Patch Changes

- 9675f38: Fix credential priority to prefer OAuth token over API key across all sandbox providers and the client.
- 0ae9f33: Glassmorphic session topbar with transparent blurry background, shorter prompt placeholders, remove font size settings, and prevent horizontal scroll on mobile.

## 1.1.2

### Patch Changes

- 76cbfd0: Fix Claude Code iterate in Sprites/Docker sandboxes by respawning with --resume instead of writing to dead stdin. Add Vite allowedHosts guardrail to generated CLAUDE.md.

## 1.1.1

### Patch Changes

- 1af3021: Fix Claude Code bridge in Sprites sandboxes

  - Fix bootstrap to install `@electric-agent/agent` (scoped) instead of legacy `electric-agent` package
  - Use SpriteCommand with tty:true but without detachable/tmux to fix immediate exit
  - Strip ANSI escape sequences from tty output before parsing stream-json NDJSON

## 1.1.0

### Minor Changes

- 89d4cb6: Add Claude Code CLI bridge mode for interactive sandbox sessions

  - New `stream-json-parser` translates Claude Code's NDJSON output into EngineEvents for the existing Durable Streams pipeline
  - New `ClaudeCodeDockerBridge` and `ClaudeCodeSpritesBridge` spawn `claude` CLI with `--output-format stream-json` inside sandboxes
  - New `generateClaudeMd()` produces workspace CLAUDE.md with scaffold structure, guardrails, and playbook instructions
  - Per-session agent mode toggle (`claude-code` / `electric-agent`) stored in SessionInfo, with UI settings defaulting to Claude Code
  - Sprites bootstrap now installs `@anthropic-ai/claude-code` CLI globally
  - Gate responses (ask_user_question, clarification, approval) forwarded as user messages to Claude Code's stdin

- ba8f908: Add unified hook endpoint with transcript_path correlation for Claude Code integration

  - New `POST /api/hook` endpoint that uses `transcript_path` from Claude Code hook events as a stable correlation key, replacing PID-based session tracking
  - New `GET /api/hooks/setup` installer endpoint for project-scoped hook setup
  - Registry now stores `session_mapped` events to durably map transcript paths to sessions (survives server restarts)
  - Simplified `forward.sh` from ~100 lines to ~20 lines (just curl + print hookSpecificOutput)
  - Resume correctly reuses the same EA session instead of creating duplicates
  - Race condition guard prevents duplicate sessions from concurrent hook events

- a99ba74: Add private sessions with room-based sharing, sidebar UX improvements, and manual OAuth override

  - Sessions are now stored in browser localStorage instead of a global Durable Streams registry, making them private per browser
  - Room-based sharing via invite codes: create rooms, link sessions, and view linked sessions together
  - Sidebar: joined rooms now appear before Create/Join action buttons
  - Shared session header: room participant avatars positioned before share controls
  - Settings: new OAuth Token field for manually overriding Claude authentication (takes priority over macOS Keychain)

### Patch Changes

- fixes to sprites
- Updated dependencies [a99ba74]
  - @electric-agent/protocol@1.1.0

## 1.0.0

### Major Changes

- e494542: restructured

### Minor Changes

- 9d0e4a0: monorepo
- a5c4703: Convert to pnpm workspaces monorepo with three packages: protocol, studio, and agent

### Patch Changes

- Updated dependencies [9d0e4a0]
- Updated dependencies [a5c4703]
- Updated dependencies [e494542]
  - @electric-agent/protocol@1.0.0
