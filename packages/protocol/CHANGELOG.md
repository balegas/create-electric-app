# @electric-agent/protocol

## 1.8.2

### Patch Changes

- b3da804: Add repository.url to all packages and remove NPM_TOKEN from release workflow for npm trusted publishing (OIDC).

## 1.8.1

### Patch Changes

- b0f6be8: Improve multi-agent coordination: add REVIEW_REQUEST protocol, enforce reviewer read-only guardrails, remove ui-designer from auto-created agents (available via Add Agent instead).

## 1.8.0

### Minor Changes

- 4cfbddf: Add production mode restrictions to prevent abuse during public events.

  - Disable freeform sessions in production mode (!devMode)
  - Remove WebSearch from allowed tools in production
  - Add production guardrails to generated CLAUDE.md
  - Enforce per-session cost budget ($5 default, configurable via MAX_SESSION_COST_USD)
  - Add per-IP rate limiting on session creation (5/hour default, configurable via MAX_SESSIONS_PER_IP_PER_HOUR)
  - Hardcode model to claude-sonnet-4-6 in production
  - Add budget_exceeded protocol event with client-side display
  - Expose /api/config endpoint for client feature flags

- 3f5e22a: Unify shared sessions and agent rooms into a single "Rooms" concept. Remove all legacy shared-session code: `/api/shared-sessions/*` routes, SharedSessionPage, SharedSessionHeader, useSharedSession hook, shared-session-store, presence ping system, and related CSS. Rename `SharedSessionEvent` to `RoomEvent` and `shared_session_created` to `room_created` in the protocol. The sidebar now has one "Rooms" section. Room headers display the room name and a copy-invite-code button.

## 1.7.0

### Minor Changes

- 41c4dc9: Remove Daytona sandbox provider. The project now supports two sandbox runtimes: Docker (local) and Sprites (Fly.io cloud).

### Patch Changes

- 41c4dc9: Rewrite project documentation from scratch. Add docs/ directory with detailed reference docs covering protocol & events, multi-agent rooms, sandboxes & bridges, security & authentication, architecture, and publishing. Rewrite README as a concise quick-start guide. Update CLAUDE.md with clear development instructions, pre-commit checklist, and changeset requirements.
- 5c53e82: Add role-based skills for agent rooms and multiple room UX improvements.

  **Role skills:**

  - Built-in `coder` and `reviewer` roles with skill files defining workflows, interaction protocols, and boundaries
  - Role-specific tool permissions: reviewer is read-only (no Write/Edit), coder has full access
  - Role selector dropdown in the Add Agent modal (replaces freeform text input)
  - Role skill files are injected into agent sandboxes alongside the room-messaging skill

  **Room improvements:**

  - Room-messaging skill is now injected into room agent sandboxes (was missing)
  - Fix regex lastIndex bug in message parser that caused agents to miss @room messages
  - Initial prompts sent only to the target agent (no longer broadcast to all)
  - Rooms no longer auto-close on DONE: or max rounds — only manual close via UI
  - Agent join/leave events broadcast to other participants' session streams
  - Participant avatars in room header (clickable, navigate to agent session)
  - Agent names in room messages are clickable links to their sessions
  - Room messages appear in agent session streams with sender label ([reviewer] instead of [you])
  - Removed "Direct message to session" section (redundant with room prompt input)
  - Session sidebar uses deterministic ordering (createdAt instead of lastActiveAt)
  - Reviewer skill instructs posting PR summary comment when review is complete
  - Room-messaging skill updated to encourage message acknowledgment
  - Add existing running session to a room (new/existing toggle in Add Agent modal)

## 1.6.0

### Minor Changes

- ec4822f: Add agent-to-agent communication primitive via room messaging.

  New protocol events: `agent_message`, `room_closed`, `outbound_message_gate`, `outbound_message_gate_resolved`.

  New `RoomRouter` class routes messages between agents through durable streams. Supports broadcast and direct messaging, optional per-agent gating for human approval, automatic discovery on join, turn-based conversation with configurable max rounds, and `DONE:`/`GATE:` conventions for signaling completion or requesting human input.

  New server API routes: `POST /api/rooms`, `POST /api/rooms/:id/agents`, `POST /api/rooms/:id/messages`, `GET /api/rooms/:id/events`, `GET /api/rooms/:id`, `POST /api/rooms/:id/close`.

  New skill file `.claude/skills/room-messaging/SKILL.md` teaches agents the `@room` messaging protocol.

## 1.5.0

### Minor Changes

- a6309e6: Track session costs (tokens, turns, duration) from Claude Code and display them in the session header UI. Cost data is extracted from Claude Code's stream-json result messages and accumulated across multiple runs (initial + iterate) per session.

## 1.4.0

### Minor Changes

- e25eb4b: Replace `app_ready` event with `app_status` event carrying status, port, and previewUrl. Remove 10-second polling loop for app status in the UI — preview button now driven entirely by SSE events.

## 1.3.0

### Minor Changes

- 43230e0: Support full AskUserQuestion capabilities: multiSelect, multiple questions, and headers

  - Add `AskUserQuestionItem` interface and `questions` field to the `ask_user_question` protocol event
  - Pass through full `questions` array (with `header`, `multiSelect`) from Claude Code stream-json and hook events
  - Rewrite `AskUserQuestionGate` UI to render multiple questions, multiSelect checkboxes, and header chips
  - Extract duplicated `sendGateResponse()` logic from Docker and Sprites bridges into shared `formatGateMessage()` helper
  - Switch gate resolution from single `answer` string to `answers: Record<string, string>` with backwards compat
  - Update SKILL.md Phase 0 to be less prescriptive about clarification format

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
