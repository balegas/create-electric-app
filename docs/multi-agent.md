# Multi-Agent Rooms

Electric Agent supports multi-agent collaboration through **rooms** — shared communication channels where multiple Claude agents can coordinate on a task. Each agent runs in its own isolated sandbox and session, but they exchange messages through a shared Durable Stream managed by the Room Router.

## How It Works

```
Agent 1 (sandbox A)  ──┐
                        │   @room / @name message parsing
Agent 2 (sandbox B)  ──┼──→  Durable Stream  ──→  Room Router
                        │                              │
Agent 3 (sandbox C)  ──┘                              ├→ Gated? → wait for human approval
                                                      ├→ Broadcast to all agents
                                                      └→ Direct to named agent
```

1. Each agent runs as an independent Claude Code session inside its own sandbox.
2. The **Room Router** watches the shared room stream for new messages.
3. When an agent outputs text matching the `@room` or `@name` convention, the message is parsed and routed.
4. Messages arrive at target agents via `bridge.sendCommand()`, which writes to the agent's stdin.

## Creating a Room

Rooms are created via the web UI or API:

```
POST /api/shared-sessions
{
  "name": "Architecture Review"
}
→ { "id": "uuid", "code": "A1B2C3D4", "roomToken": "..." }
```

The response includes an **invite code** (8-character alphanumeric) that others use to join.

## Adding Agents to a Room

Link an agent session to a room:

```
POST /api/shared-sessions/:roomId/sessions
Authorization: Bearer <roomToken>
{
  "sessionId": "agent-session-uuid",
  "agentName": "Architect",
  "role": "coder",
  "gated": false
}
```

When an agent joins, the Room Router sends a **discovery prompt** with:
- The room's purpose and participant roster
- Recent message history (for context)
- The `@room` / `@name` messaging protocol

## Message Format

Agents communicate using a simple text convention:

| Pattern | Behavior |
|---------|----------|
| `@room <message>` | Broadcast to all agents in the room |
| `@<name> <message>` | Direct message to a specific agent |
| `@room DONE: <summary>` | Signal that the conversation is complete |
| `@room GATE: <question>` | Pause the conversation and ask a human for input |

Messages without `@room` or `@name` are **silent** — the agent's output is not routed to the room. This lets agents think, use tools, and work without broadcasting every step.

### Examples

```
@room I've analyzed the schema. Here's my proposed data model: ...

@Reviewer Can you check if the foreign keys in my schema are correct?

@room DONE: We've agreed on a normalized schema with 5 tables.

@room GATE: Should we use soft deletes or hard deletes for the tasks table?
```

## Agent Roles

Agents can be assigned built-in roles that control their tool access:

| Role | Tools Available | Purpose |
|------|----------------|---------|
| `coder` | Read, Write, Edit, Bash, Glob, Grep, WebSearch, TodoWrite, AskUserQuestion, Skill | Full development access |
| `reviewer` | Read, Bash, Glob, Grep, TodoWrite, AskUserQuestion | Read-only code review (cannot Write/Edit) |

Roles are defined in `.claude/skills/roles/{roleName}/SKILL.md` and loaded by the bridge when spawning the Claude Code process.

## Gating

Agents can be marked as **gated** when linked to a room. A gated agent's outbound messages require human approval before being broadcast:

1. Agent outputs `@room here's my suggestion...`
2. Room Router detects the agent is gated → emits `outbound_message_gate` event
3. Web UI shows the message with approve/reject controls
4. Human approves → message is broadcast to the room
5. Human rejects → message is discarded

This is useful for agents with elevated capabilities (e.g., a coder agent whose suggestions should be reviewed before reaching other agents).

## Round Limits

Rooms have a configurable `maxRounds` (default: 20). Each message exchange counts as a round. When the limit is reached, the Room Router automatically closes the room and emits a `room_closed` event.

An agent can end the conversation early by sending `@room DONE: <summary>`.

## Room Events

All room activity is streamed as `EngineEvent` types (see [Protocol](./protocol.md)):

| Event | When |
|-------|------|
| `shared_session_created` | Room created |
| `participant_joined` | Agent or user joined |
| `participant_left` | Agent or user left |
| `session_linked` | Agent session linked to room |
| `agent_message` | Message routed through room |
| `outbound_message_gate` | Gated message awaiting approval |
| `room_closed` | Conversation ended |

## Room Registry

Room metadata is persisted in a dedicated Durable Stream (`room-registry`). This includes:
- Room ID, name, invite code
- Linked session IDs and agent names
- Room status (open/closed)

The registry survives server restarts, so rooms can be listed and resumed.
