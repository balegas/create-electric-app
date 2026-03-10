# Protocol & Events

The `@electric-agent/protocol` package defines `EngineEvent` — the union type for every event that flows between the agent, server, and web UI. It is the single source of truth for the streaming contract.

## Event Flow

```
Agent (in sandbox)
    │
    ├── Writes EngineEvents to Durable Stream
    │
    ▼
Durable Stream (persistent, append-only log)
    │
    ├── SSE proxy in server.ts reads and forwards to browser
    │     - Filters out internal events (commands, gate_responses)
    │     - Strips internal `source` field
    │
    ▼
React SPA (useSession.ts)
    │
    └── processEvent() reducer → ConsoleEntry[] state
```

Every session has its own Durable Stream. Events are append-only and survive server restarts, enabling full session replay and reconnect catch-up via `Last-Event-ID`.

## EngineEvent Types

### Session Lifecycle

| Type | Description |
|------|-------------|
| `session_start` | Emitted when the agent begins work. Includes session ID. |
| `session_end` | Emitted when the agent finishes. Includes cost metrics (input/output tokens, turns, duration). |

### Agent Output

| Type | Description |
|------|-------------|
| `assistant_message` | Claude's text response (markdown). |
| `log` | Progress messages with a `level` field: `plan`, `approve`, `task`, `build`, `fix`, `done`, `error`, `verbose`. |
| `todo_write` | Task list updates — array of `{content, status, activeForm}` items shown in the UI. |

### Tool Execution

| Type | Description |
|------|-------------|
| `pre_tool_use` | Emitted before a tool runs. Includes `tool_name` and `input`. |
| `post_tool_use` | Emitted after a tool completes. Includes `tool_name`, `response`, and optional `error`. |

Tool events are rendered as collapsible entries in the web UI — click to expand full input/output.

### Gates (Blocking Decision Points)

Gates are events where the system pauses and waits for user input before continuing.

| Type | Description |
|------|-------------|
| `ask_user_question` | Interactive prompt with options, multiSelect, and headers. Blocks until user responds. |
| `infra_config_prompt` | Infrastructure mode selection (local Docker / Electric Cloud / claim existing). |
| `gate_resolved` | Confirmation that a gate has been resolved with the user's decision. |
| `outbound_message_gate` | A gated agent's message awaiting human approval before broadcast in a room. |

### App Status

| Type | Description |
|------|-------------|
| `app_status` | Reports whether the generated app is `running` or `stopped`. Includes `port` and `previewUrl` when running. |

### Git

| Type | Description |
|------|-------------|
| `git_checkpoint` | Commit event with SHA, message, branch, and optional PR URL. |

### User Input

| Type | Description |
|------|-------------|
| `user_prompt` | Incoming message from a user or room participant. |

### Shared Session / Room Events

| Type | Description |
|------|-------------|
| `shared_session_created` | A room was created with an invite code. |
| `participant_joined` | A user or agent joined the room. |
| `participant_left` | A user or agent left the room. |
| `session_linked` | An agent session was linked to the room. |
| `agent_message` | A message routed through the room (broadcast or direct). |
| `room_closed` | The room conversation ended (via `DONE:` signal or max rounds). |

## Gate Mechanics

There are three categories of gates:

1. **Server-side gates** (`infra_config`): Resolved in-process via `createGate()` / `resolveGate()` Promise pairs. The server blocks until the user picks an option.

2. **Container-forwarded gates** (`clarification`, `approval`, `continue`, `revision`): Written to container stdin via the session bridge. The agent blocks on stdin until the response arrives.

3. **Hook gates** (`ask_user_question`): Block the HTTP response to a Claude Code hook forwarder until the user answers in the web UI.

### Gate Resolution Protocol

The client resolves gates by POSTing to:

```
POST /api/sessions/:id/respond
Authorization: Bearer <sessionToken>

{
  "gate": "approval",
  "decision": "approve"
}
```

Gate response shapes:

```json
{"gate": "approval",      "decision": "approve"}
{"gate": "clarification",  "answers": ["answer1", "answer2"]}
{"gate": "revision",       "feedback": "change the schema to use..."}
{"gate": "continue",       "proceed": true}
```

## Durable Streams

Each session's event log is backed by a [Durable Stream](https://github.com/durable-streams/durable-streams) — a persistent, append-only log that enables:

- **Real-time SSE push**: Server subscribes and proxies events to the browser.
- **Reconnect catch-up**: Client sends `Last-Event-ID` to resume from where it left off.
- **Full session replay**: Opening an old session replays all events from the start.
- **Multi-writer**: Both the server and the agent write to the same stream (distinguished by a `source` field).

Connection info is derived from `DS_URL`, `DS_SERVICE_ID`, and `DS_SECRET` environment variables. The SSE proxy hides these credentials from the browser — clients only see `/api/sessions/:id/events`.
