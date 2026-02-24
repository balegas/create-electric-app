# Plan: Align EngineEvent protocol with Claude Code hooks

## Overview

Refactor the EngineEvent protocol to use names and shapes that match Claude Code's hook event system. This is a prerequisite for the local CLI bridge integration — once our events match Claude Code's vocabulary, the bridge becomes a trivial pass-through instead of a translation layer.

The refactoring is done in two phases. Each phase has a test plan that must pass before proceeding.

---

## Phase 1: Rename EngineEvent types to match Claude Code hooks

**Goal**: Rename our event types and fields to align with Claude Code's hook vocabulary, while keeping the app fully functional end-to-end.

### Renames

| Current name | New name | Rationale |
|---|---|---|
| `tool_start` | `pre_tool_use` | Matches Claude Code's `PreToolUse` hook |
| `tool_result` | `post_tool_use` | Matches Claude Code's `PostToolUse` hook |
| `assistant_text` | `assistant_message` | Matches Claude Code's transcript format |
| `assistant_thinking` | `assistant_thinking` | Already matches — no change |
| `user_message` | `user_prompt` | Matches Claude Code's `UserPromptSubmit` hook |
| `session_complete` | `session_end` | Matches Claude Code's `SessionEnd` hook |
| `clarification_needed` | `clarification_needed` | No change — our gate, not Claude Code's |
| `plan_ready` | `plan_ready` | No change — our gate |
| `continue_needed` | `continue_needed` | No change — our gate |
| `cost_update` | `cost_update` | No change |
| `phase_complete` | `phase_complete` | No change |
| `app_ready` | `app_ready` | No change |
| `git_checkpoint` | `git_checkpoint` | No change |
| `infra_config_prompt` | `infra_config_prompt` | No change |
| `gate_resolved` | `gate_resolved` | No change |
| `log` | `log` | No change |

### Field renames within events

| Event | Current field | New field | Rationale |
|---|---|---|---|
| `pre_tool_use` (was `tool_start`) | `toolName` | `tool_name` | Matches hook's `tool_name` |
| `pre_tool_use` | `toolUseId` | `tool_use_id` | Matches hook's `tool_use_id` |
| `pre_tool_use` | `input` | `tool_input` | Matches hook's `tool_input` |
| `post_tool_use` (was `tool_result`) | `toolUseId` | `tool_use_id` | Matches hook's `tool_use_id` |
| `post_tool_use` | `output` | `tool_response` | Matches hook's `tool_response` |

### New event type

| New type | Fields | Rationale |
|---|---|---|
| `post_tool_use_failure` | `tool_use_id`, `tool_name`, `error`, `agent?`, `ts` | Matches Claude Code's `PostToolUseFailure` — currently errors are indistinguishable from successes in `tool_result` |
| `session_start` | `session_id`, `cwd?`, `agent?`, `ts` | Matches Claude Code's `SessionStart` — needed for local bridge |

### New optional field

| Event | New field | Type | Purpose |
|---|---|---|---|
| `post_tool_use` | `error?` | `string` | Distinguish tool failure when not using separate `post_tool_use_failure` type |

### Files to change

1. **`src/engine/events.ts`** — rename types and fields (source of truth)
2. **`src/web/client/src/lib/event-types.ts`** — mirror renames (client copy)
3. **`src/engine/message-parser.ts`** — update `sdkMessageToEvents()` to emit new names
4. **`src/engine/orchestrator.ts`** — update all `emit()` calls
5. **`src/engine/stream-adapter.ts`** — no changes (passes events opaquely)
6. **`src/engine/stdio-adapter.ts`** — no changes (passes events opaquely)
7. **`src/web/client/src/hooks/useSession.ts`** — update `processEvent()` reducer cases
8. **`src/web/client/src/components/Console.tsx`** — update `ConsoleEntry` kind references
9. **`src/web/client/src/components/ConsoleEntry.tsx`** — update kind references
10. **`src/web/client/src/components/ToolExecution.tsx`** — update `tool_name`, `tool_input`, `tool_response` field names
11. **`src/web/client/src/components/GatePrompt.tsx`** — update gate type references
12. **`src/web/server.ts`** — update SSE proxy filter for new type names
13. **`src/web/bridge/hosted.ts`** — update `session_complete` → `session_end` detection
14. **`src/cli/headless.ts`** — update any event type references
15. **`tests/bridge.test.ts`** — update event type names in test fixtures
16. **`tests/streams.test.ts`** — update event type names in test fixtures

### ConsoleEntry renames (client-side)

The `ConsoleEntry` type uses `kind` to distinguish UI entries. Renames:

| Current `kind` | New `kind` | Rationale |
|---|---|---|
| `tool` | `tool_use` | Encompasses both pre/post, aligns with Claude Code |
| `text` | `assistant_message` | Matches event rename |
| `thinking` | `assistant_thinking` | Already aligned |
| `user_message` | `user_prompt` | Matches event rename |
| `log` | `log` | No change |
| `gate` | `gate` | No change |

Field renames within `ConsoleEntry`:

| Kind | Current field | New field |
|---|---|---|
| `tool_use` | `toolName` | `tool_name` |
| `tool_use` | `toolUseId` | `tool_use_id` |
| `tool_use` | `input` | `tool_input` |
| `tool_use` | `output` | `tool_response` |

### Implementation order

1. Update `src/engine/events.ts` (server types)
2. Update `src/web/client/src/lib/event-types.ts` (client types)
3. Run `npx tsc --noEmit` — use compiler errors to find every reference
4. Fix each file following the compiler errors
5. Run `npm run check:fix` to fix formatting
6. Run `npm run build` to verify full build
7. Run `npm test` to verify existing tests pass

### Phase 1 test plan

Before moving to Phase 2, **all of these must pass**:

```bash
# 1. Type-check (zero errors)
npx tsc --noEmit

# 2. Lint + format (zero errors)
npm run check

# 3. Full build (TypeScript + Vite SPA)
npm run build

# 4. Unit + integration tests
npm test

# 5. Manual verification: events flow through stream correctly
#    (covered by existing streams.test.ts and bridge.test.ts)
```

Acceptance criteria:
- [ ] All 16 event types use new names in both server and client
- [ ] All field names use snake_case matching Claude Code's hook schemas
- [ ] `ConsoleEntry` kinds match the new event names
- [ ] `useSession.ts` reducer handles all renamed types
- [ ] All UI components render correctly with renamed fields
- [ ] SSE proxy filter in `server.ts` works with new type names
- [ ] Bridge `session_end` detection works (was `session_complete`)
- [ ] `npm run build` succeeds (TypeScript + Vite)
- [ ] `npm test` passes (bridge, streams, NDJSON, scaffold tests)
- [ ] `npm run check` passes (Biome lint + format)

---

## Phase 2: Hook-to-stream bridge — local Claude Code sessions

**Goal**: Let Claude Code running locally forward hook events to the web UI via Durable Streams, with no sandbox involved. This enables live debugging of the UI against real Claude Code sessions.

### Architecture

```
Claude Code (local CLI)
  │
  │  hooks fire on PreToolUse, PostToolUse, Stop, SessionStart, etc.
  │  each hook runs forward.sh which POSTs JSON to localhost
  ↓
Web Server (localhost:4400)
  POST /api/sessions/:id/hook-event
  │  maps hook JSON → EngineEvent
  │  writes to Durable Stream via HostedStreamBridge.emit()
  ↓
Durable Stream (hosted)
  ↓
SSE Proxy (/api/sessions/:id/events)
  ↓
Web UI (React SPA)
  renders events in Console
```

**Key difference from sandbox bridges**: The local bridge is write-only (hooks → stream). There's no `sendCommand()` or `sendGateResponse()` — Claude Code doesn't read from our stream. Gate support (AskUserQuestion) is a future phase.

### Hook event → EngineEvent mapping

After Phase 1 renames, the mapping is nearly 1:1:

| Hook event | EngineEvent type | Fields carried through |
|---|---|---|
| `SessionStart` | `session_start` | `session_id`, `cwd` |
| `PreToolUse` | `pre_tool_use` | `tool_name`, `tool_use_id`, `tool_input` |
| `PostToolUse` | `post_tool_use` | `tool_use_id`, `tool_name`, `tool_response` |
| `PostToolUseFailure` | `post_tool_use_failure` | `tool_use_id`, `tool_name`, `error` |
| `Stop` | `assistant_message` | `last_assistant_message` → `text` |
| `SessionEnd` | `session_end` | `session_id` |
| `SubagentStart` | `log` (level: "info") | Agent type as message |
| `SubagentStop` | `log` (level: "info") | Agent type as message |

### Hook configuration

File: `.claude/settings.local.json` (gitignored — per-developer, not committed)

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": ".claude/hooks/forward.sh" }] }
    ],
    "PreToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": ".claude/hooks/forward.sh" }] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": ".claude/hooks/forward.sh" }] }
    ],
    "PostToolUseFailure": [
      { "matcher": "", "hooks": [{ "type": "command", "command": ".claude/hooks/forward.sh" }] }
    ],
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": ".claude/hooks/forward.sh" }] }
    ],
    "SessionEnd": [
      { "matcher": "", "hooks": [{ "type": "command", "command": ".claude/hooks/forward.sh" }] }
    ]
  }
}
```

### Hook forwarder script

File: `.claude/hooks/forward.sh`

```bash
#!/bin/bash
# Forward Claude Code hook events to the local web server.
# SESSION_ID must be set in the environment before starting Claude Code.

if [ -z "$EA_SESSION_ID" ]; then
  exit 0  # No session — silently skip
fi

EA_PORT="${EA_PORT:-4400}"

curl -s -X POST "http://localhost:${EA_PORT}/api/sessions/${EA_SESSION_ID}/hook-event" \
  -H "Content-Type: application/json" \
  -d "$(cat)" \
  --max-time 5 \
  --connect-timeout 2 \
  > /dev/null 2>&1

exit 0  # Never block Claude Code
```

### Server endpoint

New route in `src/web/server.ts`:

```
POST /api/sessions/:id/hook-event
```

- Receives raw hook JSON from Claude Code (via `forward.sh`)
- Reads `hook_event_name` field to determine mapping
- Maps to `EngineEvent` using the table above
- Writes to Durable Stream via `bridge.emit()`
- Returns 200 immediately (hooks must not block)

If the session doesn't have a bridge yet, creates a `HostedStreamBridge` on the fly (same as `getOrCreateBridge()`).

### Local session creation endpoint

New route in `src/web/server.ts`:

```
POST /api/sessions/local
```

Body: `{ description?: string }`

- Creates a `sessionId` (UUID)
- Creates the Durable Stream (same as existing session creation)
- Creates a `SessionInfo` with `status: "running"`, no sandbox
- Creates a `HostedStreamBridge` for the session
- Returns `{ sessionId }` — caller sets `EA_SESSION_ID` env var

No sandbox provider involved. No infra gate. Just a stream + session index entry.

### Files to create

1. **`.claude/hooks/forward.sh`** — hook forwarder script (committed, works for any developer)
2. **`.claude/settings.local.json`** — hook config (gitignored, template provided)

### Files to modify

1. **`src/web/server.ts`** — add `POST /api/sessions/local` + `POST /api/sessions/:id/hook-event`
2. **`src/web/client/src/lib/api.ts`** — add `createLocalSession()` wrapper
3. **`src/web/client/src/pages/HomePage.tsx`** — add "Local session" button (optional, can also use curl)
4. **`.gitignore`** — ensure `.claude/settings.local.json` is ignored

### Implementation order

1. Add `POST /api/sessions/local` endpoint — create session + stream without sandbox
2. Add `POST /api/sessions/:id/hook-event` endpoint — receive + map + emit hook events
3. Create `.claude/hooks/forward.sh` forwarder script
4. Create `.claude/settings.local.json` template (or document the setup)
5. Run `npm run check:fix` + `npm run build` + `npm test`
6. Manual test: start server, create local session, start Claude Code, verify events in UI

### Phase 2 test plan

```bash
# 1. Type-check
npx tsc --noEmit

# 2. Lint + format
npm run check

# 3. Build
npm run build

# 4. Tests
npm test
```

**Manual integration test (the real test):**

```bash
# Terminal 1: start web server
DS_URL=... DS_SERVICE_ID=... DS_SECRET=... npm run serve

# Terminal 2: create a local session
SESSION_ID=$(curl -s -X POST http://localhost:4400/api/sessions/local \
  -H "Content-Type: application/json" \
  -d '{"description":"test local bridge"}' | jq -r .sessionId)
echo "Open http://localhost:4400/session/$SESSION_ID"

# Terminal 3: start Claude Code with hooks forwarding to the session
EA_SESSION_ID=$SESSION_ID claude
```

Events from Claude Code should appear live in the web UI console.

Acceptance criteria:
- [ ] `POST /api/sessions/local` creates session + stream without sandbox
- [ ] `POST /api/sessions/:id/hook-event` maps all 6 hook types to EngineEvents
- [ ] Hook forwarder script POSTs to server without blocking Claude Code
- [ ] Events appear in the web UI SSE stream in real-time
- [ ] PreToolUse events render tool name + input in the Console
- [ ] PostToolUse events render tool response
- [ ] Stop events render assistant message text
- [ ] SessionEnd marks the session as complete
- [ ] Existing sandbox-based sessions are unaffected
- [ ] `npm run build` succeeds
- [ ] `npm test` passes
- [ ] `npm run check` passes

---

## Phase 3: Rich tool rendering + bidirectional gates (future)

_Depends on Phase 2._ With live Claude Code sessions visible in the UI, add:

- **TodoWrite** progress widget — intercept `pre_tool_use` where `tool_name === "TodoWrite"`, render task list with status indicators
- **AskUserQuestion** gate — intercept `pre_tool_use` where `tool_name === "AskUserQuestion"`, render structured question UI, feed response back via hook stdout
- **Bidirectional gate protocol** — extend `forward.sh` to read server responses (for AskUserQuestion blocking flow)

---

## Phase 4: Production polish + Docker integration test (future)

_Depends on Phase 3._

- Session lifecycle management (cleanup stale local sessions)
- Auto-register sessions on first hook event (no manual `curl` step)
- Docker-based integration test that validates the full hook → stream → UI flow
- Documentation for setting up Claude Code hooks per-project
