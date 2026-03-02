# Architecture

## System Overview

electric-agent is a multi-agent platform that generates reactive Electric SQL + TanStack DB applications from natural language. It consists of three packages in a pnpm monorepo:

```
@electric-agent/protocol  ──>  @electric-agent/studio  ──>  @electric-agent/agent
     (event types)              (web UI + sandboxes)         (code gen agents + CLI)
```

## Request Lifecycle

```
Browser (React SPA)
  │
  ├── POST /api/sessions          ← create session + get sessionToken
  │     │
  │     ├── Create Durable Stream (event log)
  │     ├── Emit infra_config_prompt gate
  │     ├── Wait for gate resolution (user picks infra mode)
  │     ├── Create sandbox (Docker / Sprites / Daytona)
  │     ├── Create bridge (stream / stdio / claude-code)
  │     └── Send "new" command to agent
  │
  ├── GET /api/sessions/:id/events?token=...   ← SSE stream (proxied from Durable Streams)
  │
  ├── POST /api/sessions/:id/iterate           ← send follow-up instructions
  │     Authorization: Bearer <sessionToken>
  │
  └── POST /api/sessions/:id/respond           ← resolve gates (approvals, clarifications)
        Authorization: Bearer <sessionToken>
```

## Session Token Authentication

Session-scoped endpoints are protected by stateless HMAC tokens. No server-side token storage is needed — tokens are derived deterministically from the session ID.

### How It Works

```
                    Creation                              Subsequent Requests
                    ────────                              ───────────────────

Server:  sessionId = UUID                    Client sends: Authorization: Bearer <token>
         token = HMAC-SHA256(DS_SECRET,      Server re-derives: expected = HMAC-SHA256(DS_SECRET, sessionId)
                             sessionId)      Validates: timingSafeEqual(expected, token)
         Return { sessionId, sessionToken }
                    │
Client:  Store token in localStorage
         (key: "electric-agent:session-tokens")
```

### Token Derivation

```typescript
// packages/studio/src/session-auth.ts
HMAC-SHA256(DS_SECRET, sessionId) → 64-char hex string
```

- **Secret**: Reuses `DS_SECRET` (Durable Streams JWT secret) — no additional secret required
- **Validation**: Uses `crypto.timingSafeEqual` to prevent timing attacks
- **Storage**: Client stores tokens in a separate localStorage key, keyed by session ID

### Protected vs Exempt Endpoints

| Endpoint | Auth Required | Notes |
|----------|:---:|-------|
| `POST /api/sessions` | No | Creation — returns `sessionToken` |
| `POST /api/sessions/local` | No | Creation — returns `sessionToken` |
| `POST /api/sessions/auto` | No | Creation — returns `sessionToken` |
| `POST /api/sessions/resume` | No | Creation — returns `sessionToken` |
| `POST /api/hook` | No | Local hook forwarder — no session param |
| `POST /api/sessions/:id/hook-event` | No | Local trusted traffic (exempt) |
| `GET /api/sessions/:id` | Yes | Header or query param |
| `DELETE /api/sessions/:id` | Yes | Header |
| `POST /api/sessions/:id/iterate` | Yes | Header |
| `POST /api/sessions/:id/respond` | Yes | Header |
| `GET /api/sessions/:id/events` | Yes | Query param (`?token=`) — EventSource limitation |
| `GET /api/sessions/:id/app-status` | Yes | Header or query param |
| `POST /api/sessions/:id/*` | Yes | All other session sub-routes |

### Client Integration

**REST requests** (`api.ts`): The `request()` helper extracts the session ID from the URL path and attaches `Authorization: Bearer <token>` automatically.

**SSE/EventSource** (`useSession.ts`): Since `EventSource` does not support custom headers, the token is passed as a `?token=` query parameter.

**Token lifecycle**: Tokens are captured from creation responses (`createSession`, `createLocalSession`, `resumeFromGithub`) and stored via `setSessionToken()`. When a session is removed from localStorage, the corresponding token is also deleted.

### Hono Middleware Implementation

Two middleware layers in `server.ts` enforce auth:

```typescript
app.use("/api/sessions/:id/*", ...)  // Sub-resource routes
app.use("/api/sessions/:id", ...)    // Base path (GET/DELETE only)
```

**Hono routing caveat**: `app.use("/api/sessions/:id/*")` also matches creation routes like `/api/sessions/local` (Hono treats `local` as `:id`). The middleware skips an explicit set of exempt IDs (`local`, `auto`, `resume`). New creation routes under `/api/sessions/<name>` must be added to `authExemptIds`.

### Migration

No grace period is needed. `ActiveSessions` is in-memory only — server restarts clear it. Old localStorage sessions will 404 on `GET /api/sessions/:id`, and the client handles this gracefully. Users simply create new sessions.

## Room Token Authentication

Shared sessions (rooms) use the same HMAC token mechanism as sessions. The invite code serves as the initial authentication — knowing the code grants the room token.

### How It Works

```
        Creator                          Joiner (via invite code)
        ───────                          ────────────────────────

Server: roomId = UUID                   GET /api/shared-sessions/join/:code
        roomToken = HMAC(DS_SECRET,       → Returns { id, roomToken }
                         roomId)
        Return { id, code, roomToken }  Client stores roomToken

Client: Store roomToken in             All subsequent requests:
        localStorage                    Authorization: Bearer <roomToken>
        (key: "electric-agent:room-tokens")
```

### Protected vs Exempt Endpoints

| Endpoint | Auth Required | Notes |
|----------|:---:|-------|
| `POST /api/shared-sessions` | No | Creation — returns `roomToken` |
| `GET /api/shared-sessions/join/:code` | No | Code lookup — returns `roomToken` |
| `POST /api/shared-sessions/:id/join` | Yes | Join as participant |
| `POST /api/shared-sessions/:id/leave` | Yes | Leave room |
| `POST /api/shared-sessions/:id/sessions` | Yes | Link a session |
| `DELETE /api/shared-sessions/:id/sessions/:sid` | Yes | Unlink a session |
| `GET /api/shared-sessions/:id/events` | Yes | SSE stream (`?token=` query param) |
| `POST /api/shared-sessions/:id/revoke` | Yes | Revoke invite code |

### Client Integration

Same pattern as session tokens: `request()` extracts the shared session ID from the URL path and attaches `Authorization: Bearer <roomToken>`. SSE uses `?token=` query param. Tokens stored in `"electric-agent:room-tokens"` localStorage key.

## Sandbox Providers

Three sandbox runtimes are supported, selected via `SANDBOX_RUNTIME` env var:

| Runtime | Provider | Use Case |
|---------|----------|----------|
| `docker` (default) | `DockerSandboxProvider` | Local development, requires Docker daemon |
| `sprites` | `SpritesSandboxProvider` | Fly.io cloud micro-VMs, used in production |
| `daytona` | `DaytonaSandboxProvider` | Daytona cloud sandboxes, alternative cloud runtime |

## Bridge Modes

Bridges connect the server to the agent process running inside the sandbox:

| Mode | Bridge | How It Works |
|------|--------|-------------|
| `stream` (default) | `HostedStreamBridge` | Agent reads/writes Durable Streams directly via DS env vars |
| `stdio` | `DockerStdioBridge` / `SpritesStdioBridge` / `DaytonaSessionBridge` | Server pipes NDJSON via stdin/stdout to the container |
| `claude-code` | `ClaudeCodeDockerBridge` / `ClaudeCodeSpritesBridge` | Spawns `claude` CLI with stream-json I/O inside the sandbox |

## Event Flow

```
Agent (in sandbox)
  │
  ├── Writes EngineEvents to Durable Stream
  │     (tool_use, assistant_message, session_end, etc.)
  │
  ▼
Durable Stream (persistent event log)
  │
  ├── SSE Proxy (server.ts) reads and forwards to browser
  │     - Filters out protocol messages (commands, gate_responses)
  │     - Strips internal `source` field
  │
  ▼
React SPA (useSession.ts)
  │
  └── processEvent() reducer updates ConsoleEntry[] state
```

## Gate System

Gates are blocking decision points where the system waits for user input:

- **Server-side gates** (`infra_config`): Resolved in-process via `createGate()` / `resolveGate()` Promises
- **Container-forwarded gates** (`clarification`, `approval`, `continue`, `revision`): Written to container stdin via the bridge
- **Hook gates** (`ask_user_question`): Block the HTTP response to the Claude Code hook forwarder until the user answers in the web UI

## Durable Streams

Each session has its own Durable Stream — a persistent, append-only event log that enables:

- **Real-time SSE push**: Server subscribes to the stream and proxies events to the browser
- **Reconnect catch-up**: Client sends `Last-Event-ID` header to resume from where it left off
- **Full session replay**: Opening an old session replays all events from the beginning
- **Multi-writer**: Both the server and the agent can write to the same stream (distinguished by `source` field)

Connection info is derived from `DS_URL`, `DS_SERVICE_ID`, and `DS_SECRET` env vars. The SSE proxy hides these credentials from the browser — the client only sees the proxied `/api/sessions/:id/events` endpoint, authenticated by the session token.
