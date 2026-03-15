# @electric-agent/studio

## 1.14.0

### Minor Changes

- b0f6be8: Improve multi-agent coordination: add REVIEW_REQUEST protocol, enforce reviewer read-only guardrails, remove ui-designer from auto-created agents (available via Add Agent instead).

### Patch Changes

- Updated dependencies [b0f6be8]
  - @electric-agent/protocol@1.8.1

## 1.13.3

### Patch Changes

- 622d337: Fix flash of "No messages yet." when creating a room by showing a "Creating room" loading state while roomId is "new".
- 622d337: Add app preview button to room header (mobile icon + desktop text link). The server now returns previewUrl and appPort in the room state response.

## 1.13.2

### Patch Changes

- b2549bd: Always show the Open App button in the UI when a preview URL or port is available, regardless of app completion state. Add a DONE room message to the create-app skill's final phase to signal pipeline completion. Initialize all agents with repo info (URL, branch) via the room router's discovery prompt so they can clone and review code locally.
- 6e69388: Move DONE message responsibility to room-messaging skill instead of auto-generating it in server onComplete handler. The server no longer emits `@room DONE:` when the coder session exits successfully — only the coder agent itself should send DONE after verifying the app is ready.
- 75fbc3d: Restrict UI agent to only act on explicit user requests, not on coder DONE messages.

## 1.13.1

### Patch Changes

- 3f6b96c: Fix duplicate DONE messages from coder agent. The server's onComplete handler now checks whether the coder already sent its own @room DONE: message before emitting a second one. Also updated UI designer role to ask the user before starting a UI audit when the app is complete.
- 90b3712: Fix "Open App" link not showing on session resume for Sprites. The link now activates after the first "done" log message using the session's previewUrl as fallback, instead of relying solely on the app_status event which often lacks port/previewUrl on replay.
- 3f6b96c: Fix UI bugs: gate color now turns blue immediately after responding (instead of losing color until agent stops), agents announce in room channel when picking up a DONE task, and room prompt bar stacks correctly on mobile with 3 elements.

## 1.13.0

### Minor Changes

- 9cbc6f8: Add hosted production mode with server-side Claude API key, rate limiting (global session cap, per-IP limits, per-session cost budget), GitHub App integration for automatic repo creation under electric-apps org, git credential helper for transparent token management in sandboxes, and random slug naming for prod repos. Dev mode retains full credential UI and no rate limits. Agent template updated with README writing step in create-app skill.
- 5591cbd: Add multi-agent room workflow for app creation. When a user submits an app description, the system creates a room with 3 agents (coder, reviewer, UI designer) that collaborate via room messaging. Includes new POST /api/rooms/create-app endpoint, client-side room creation flow, and UI designer role registration.
- e17104c: Session persistence, bridge resurrection, and UI polish

  - Persist sessions across server restarts via durable stream Registry
  - Reconnect Docker containers on startup (match running containers to sessions)
  - Recreate ClaudeCodeDockerBridge on iterate after restart (fixes agent not responding)
  - Consistent room container naming: all agents use `room-{name}-{id}` prefix
  - Add needsInput flag with orange avatar ring on sidebar when agent awaits user input
  - Emit room messages on gate resolve ("received input — resuming")
  - Fix GatePrompt crash (Array.isArray guard for questions)
  - Fix "is working" indicator shown when agent is waiting for input
  - Switch all fonts from monospace to sans-serif (OpenSauceOne)
  - Remove bold fonts from avatars

## 1.12.1

### Patch Changes

- 2874544: Hide Claude Sessions button and debug section in production mode. Remove natural-language command intercepts (start/stop/restart app, git ops) from the iterate endpoint. Fix room join auth by moving join endpoint to `/api/join-room/:id/:code` outside the protected `/api/rooms/:id/*` namespace.
- d2f56e8: Instruct agents to always place @room directives on their own line so the parser can reliably extract them.

## 1.12.0

### Minor Changes

- b4056bd: Security: proxy Durable Streams so DS_SECRET never leaves the server process.

  - Remove `getStreamEnvVars()` from public API (DS_SECRET was exposed to callers)
  - Remove `streamUrl`/`streamHeaders` from `SessionBridge` interface and bridge class fields (credentials no longer stored as class state)
  - Add `/api/sessions/:id/stream/append` proxy endpoint with Content-Type, size limit (64KB), and JSON validation
  - Bridges pass DS credentials only to DurableStream constructor — no field retention

- 27da189: Lean create-app skill: delegate implementation details to playbook skills

  The create-app skill was rewritten to be an orchestration layer rather than a prescriptive code template. Implementation details (collection setup, mutations, live queries, API routes) are now delegated to playbook skills shipped with npm dependencies (`@electric-sql/client`, `@tanstack/db`, `@tanstack/react-db`), discovered dynamically via `npx @tanstack/intent list`.

  Key changes:

  - Added Phase 2 "Discover & Learn" that runs `npx @tanstack/intent list` after plan approval
  - Removed code templates that duplicated playbook content (52% smaller skill)
  - Fixed wrong hardcoded playbook paths in CLAUDE.md (`@electric-sql/playbook/` → dynamic discovery)
  - Reduced CLAUDE.md/skill duplication (drizzle workflow, SSR rules, playbook paths)
  - Kept scaffold-specific gotchas not covered by playbooks (zod/v4, protected files, import rules)
  - Added `scripts/setup-local-sandbox.sh` for local testing of the agent pipeline

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

### Patch Changes

- 93f5982: Disable `/api/credentials/keychain` endpoint by default. It now requires explicit opt-in via `devMode: true` or `STUDIO_DEV_MODE=1` env var to prevent exposing OAuth tokens in non-development environments.
- 806c25a: Add authentication middleware for room routes to prevent unauthenticated access to room state, messages, agents, and SSE events.
- 249eea5: Room UX improvements: purple working indicator, auto-generated agent names, greeting on join, simplified add-agent form, error display for not-found sessions/rooms, and sidebar label renames.
- 806c25a: Fix command injection vulnerabilities in sprites sandbox, add authentication to /api/hook endpoint, and remove OAuth token logging.
- Updated dependencies [4cfbddf]
- Updated dependencies [3f5e22a]
  - @electric-agent/protocol@1.8.0

## 1.11.0

### Minor Changes

- ff36816: Add Room UI for agent-to-agent messaging: create rooms, add agents, live SSE message stream, broadcast and targeted messaging, direct session iterate endpoint.
- b80b6e0: Agent room improvements: joinable rooms via invite code, agent sessions in sidebar, agent name labels in session console
- 1434666: Security: authenticate hook-event endpoint with scoped HMAC tokens and require id+code for room joins

  - Hook-event endpoint now requires a purpose-scoped HMAC token (`deriveHookToken`) instead of being auth-exempt
  - Hook token is derived with a `hook:` prefix so it cannot be used as a session token
  - Sprites and Docker containers receive only the scoped hook token, not `DS_SECRET`
  - Room/shared-session join endpoints now require both the session ID and invite code, preventing brute-force of short codes
  - Join token format changed to `id:code` for copy/paste workflows

- 41c4dc9: Remove Daytona sandbox provider. The project now supports two sandbox runtimes: Docker (local) and Sprites (Fly.io cloud).
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

- 29d02f3: Improve agent room UX: extract shared bridge base class, queue messages instead of interrupting busy agents, add working indicator to room conversation, unify avatar styles between sidebar and room header, sync running status to sidebar, skip Electric infra for freeform sessions, inject room-messaging skill reference into CLAUDE.md, and remove role/gated from existing session flow.

### Patch Changes

- f14b9ff: Align guardrails with TanStack playbooks and restore skill discovery.

  - Adopt TanStack's `z.union([z.string(), z.date()]).transform().default()` timestamp
    pattern (from tanstack-db/collections/SKILL.md) — strictly better than our old
    `z.union([z.date(), z.string()]).default()` because it converts strings to Dates
  - Remove stale `z.coerce.date()` ban — works correctly with zod >=3.25
  - Bump zod from `^3.24` to `^3.25` to satisfy drizzle-zod 0.8.x peer dep
  - Add all TanStack DB sub-skills (collections, schemas, mutations, live-queries,
    electric) to playbook listing with updated reading order
  - Integrate `npx @tanstack/intent list` into create-app Phase 1 for dynamic
    skill discovery
  - Keep `zod/v4` import requirement (verified: drizzle-zod rejects v3 overrides)
  - Revert fragile mv/cat/append CLAUDE.md merge back to simple overwrite

- 41c4dc9: Rewrite project documentation from scratch. Add docs/ directory with detailed reference docs covering protocol & events, multi-agent rooms, sandboxes & bridges, security & authentication, architecture, and publishing. Rewrite README as a concise quick-start guide. Update CLAUDE.md with clear development instructions, pre-commit checklist, and changeset requirements.
- Updated dependencies [41c4dc9]
- Updated dependencies [41c4dc9]
- Updated dependencies [5c53e82]
  - @electric-agent/protocol@1.7.0

## 1.10.0

### Minor Changes

- 516c152: Deploy room-messaging skill into sandboxes so agents have persistent access to the multi-agent communication protocol reference.
- fd7e0d2: Add "New Session" button to sidebar for starting freeform sessions without the create-app skill pipeline. Fix submit button not appearing when typing a custom "Other" answer in single-select question gates.

### Patch Changes

- d71c691: Fix lint issues: remove unused private class members and variable, fix formatting.
- e9ee43b: Adopt @tanstack/intent for skill discovery: remove hardcoded playbook paths from CLAUDE.md generator, prepend Electric-specific instructions on top of KPB's CLAUDE.md (preserving intent skill mappings), bump TanStack/Electric dependency versions, and remove stale durable-streams references.

## 1.9.0

### Minor Changes

- ec4822f: Add agent-to-agent communication primitive via room messaging.

  New protocol events: `agent_message`, `room_closed`, `outbound_message_gate`, `outbound_message_gate_resolved`.

  New `RoomRouter` class routes messages between agents through durable streams. Supports broadcast and direct messaging, optional per-agent gating for human approval, automatic discovery on join, turn-based conversation with configurable max rounds, and `DONE:`/`GATE:` conventions for signaling completion or requesting human input.

  New server API routes: `POST /api/rooms`, `POST /api/rooms/:id/agents`, `POST /api/rooms/:id/messages`, `GET /api/rooms/:id/events`, `GET /api/rooms/:id`, `POST /api/rooms/:id/close`.

  New skill file `.claude/skills/room-messaging/SKILL.md` teaches agents the `@room` messaging protocol.

### Patch Changes

- 605e845: Restore hero subtitle to "Build Reactive apps on Sync", change prompt placeholder to "What do you want to build?", and update Caddyfile to split traffic between backend and Vite dev server for HMR support.
- f7fbab8: Fix mobile header UX: icon-only Open App button in header bar, taller sticky topbar, prevent container drag, update hero prompt text.
- 57fd4ac: Fix mobile home page overscroll: prevent pull-to-drag rubber-band effect by adding overscroll-behavior: none and constraining hero to viewport.
- e3dccd2: Log the agent package version from the sandbox to the web UI after project setup. Emit error log events to the UI when session create/resume flows fail. Fix PR preview sprites auth to use dedicated SPRITES_API_TOKEN.
- Updated dependencies [ec4822f]
  - @electric-agent/protocol@1.6.0

## 1.8.0

### Minor Changes

- a34184d: Inject git instructions into CLAUDE.md so the agent creates GitHub repos and pushes code when configured. Previously, repo config was collected from the user but never acted upon. Also removes the deprecated `generateElectricAgentClaudeMd` function.
- a6309e6: Track session costs (tokens, turns, duration) from Claude Code and display them in the session header UI. Cost data is extracted from Claude Code's stream-json result messages and accumulated across multiple runs (initial + iterate) per session.

### Patch Changes

- 7163eee: Instruct the agent to commit and push the final generated app code as the last step, not just the initial scaffold.
- Updated dependencies [a6309e6]
  - @electric-agent/protocol@1.5.0

## 1.7.0

### Minor Changes

- da2f763: Fix shared room linked session visibility and presence tracking.

  - Add session token relay endpoint so room participants can view linked session streams
  - Replace stream-based participant tracking with heartbeat-based presence (ping every 30s, stale after 90s)
  - Fix sidebar room reordering on click

## 1.6.0

### Minor Changes

- e25eb4b: Replace `app_ready` event with `app_status` event carrying status, port, and previewUrl. Remove 10-second polling loop for app status in the UI — preview button now driven entirely by SSE events.

### Patch Changes

- d259e9d: Fix Docker sandbox clone failing when resuming the same repo twice by clearing stale target directory before cloning.
- 6bbb48a: Make GitHub token client-side only — server-side git functions now require an explicit token parameter and never fall back to ambient GH_TOKEN environment variable.
- e21e8a7: Fix excessive top padding in shared room session panels by overriding the topbar-height offset that only applies on the main session page.
- Updated dependencies [e25eb4b]
  - @electric-agent/protocol@1.4.0

## 1.5.0

### Minor Changes

- 6c3de57: Start Claude Code automatically on resume from GitHub instead of leaving the session idle

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
