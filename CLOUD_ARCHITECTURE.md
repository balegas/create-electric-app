# Cloud Runtime Architecture

## Overview

The cloud runtime architecture extends `create-electric-app` to support multiple sandbox providers (Docker, Daytona) with a unified communication layer via hosted Durable Streams. Both the web server and sandboxes connect to the same hosted stream — no stdout piping or tunnels needed.

---

## Key Design Decisions

### 1. Hosted Durable Streams as the Rendezvous Point

Instead of piping container stdout to a local DurableStream server, both the web server and the sandbox connect directly to the **hosted Durable Streams service** (`api.electric-sql.cloud`). This eliminates the need for:
- Local `DurableStreamTestServer` in production
- Network tunnels for cloud sandboxes to reach the server
- Stdout bridging (`container-bridge.ts`)

### 2. Bidirectional Protocol on a Single Stream

Each session gets one durable stream. Messages are tagged with a `source` field:

```
source: "agent"   — events from the sandbox (engine events, tool results, etc.)
source: "server"  — commands and gate responses from the web server
```

Each consumer filters by source:
- **Web UI**: subscribes and displays `source: "agent"` events
- **Sandbox**: subscribes and processes `source: "server"` commands/gate responses

### 3. SessionBridge Abstraction

A `SessionBridge` interface abstracts all stream interaction. Two implementations:
- `HostedStreamBridge` — connects to the hosted Durable Streams service
- `LocalStreamBridge` — wraps the local `DurableStreamTestServer` (development fallback)

### 4. SandboxProvider as Pure CRUD

The `SandboxProvider` interface is simplified to pure lifecycle management (create, get, list, destroy) plus file/exec operations. Communication (commands, gate responses, events) flows through the `SessionBridge`, not the provider.

---

## Stream Protocol

### Stream URL Pattern

```
{DS_URL}/v1/stream/{DS_SERVICE_ID}/session/{sessionId}
```

Example:
```
https://api.electric-sql.cloud/v1/stream/svc-cheerful-tortoise-j9ql9ikdei/session/abc123
```

### Authentication

All stream operations include:
```
Authorization: Bearer {DS_SECRET}
```

### Message Format

Every message on the stream is a JSON object with at minimum:
```json
{ "source": "agent" | "server", "type": "...", "ts": "..." }
```

**Agent messages** (`source: "agent"`):
These are `EngineEvent` objects with an added `source` field:
```json
{ "source": "agent", "type": "log", "level": "task", "message": "...", "ts": "..." }
{ "source": "agent", "type": "tool_start", "toolName": "Write", "toolUseId": "...", "ts": "..." }
{ "source": "agent", "type": "session_complete", "success": true, "ts": "..." }
```

**Server messages** (`source: "server"`):
```json
{ "source": "server", "type": "command", "command": "new", "description": "...", "ts": "..." }
{ "source": "server", "type": "command", "command": "iterate", "request": "...", "ts": "..." }
{ "source": "server", "type": "gate_response", "gate": "approval", "decision": "approve", "ts": "..." }
{ "source": "server", "type": "gate_response", "gate": "clarification", "answers": [...], "ts": "..." }
```

### Headless Stream Mode

The headless adapter gains a new mode alongside stdio:

| Mode | Transport | Use Case |
|------|-----------|----------|
| `stdio` | stdin/stdout NDJSON | Docker containers (backward compat) |
| `stream` | Hosted Durable Streams | Daytona sandboxes, cloud runtimes |

In stream mode, the headless process:
1. Connects to the stream using `DS_URL`, `DS_SERVICE_ID`, `DS_SECRET`, and `SESSION_ID` env vars
2. Subscribes and filters for `source: "server"` messages
3. Writes engine events with `source: "agent"`
4. The first `source: "server", type: "command"` message is the initial config

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Web Browser (React SPA)                  │
│  useSession() subscribes via SSE to stream                   │
│  POST /api/sessions/:id/respond → server writes gate_response│
└─────────────────────┬───────────────────────────────────────┘
                      │ HTTP
┌─────────────────────▼───────────────────────────────────────┐
│                   Hono Web Server                            │
│                                                              │
│  SessionBridge ◄──► Hosted Durable Streams Service           │
│    .emit(event)         (api.electric-sql.cloud)             │
│    .sendCommand(cmd)         ▲                               │
│    .sendGateResponse(...)    │                               │
│    .onAgentEvent(cb)         │                               │
│                              │                               │
│  SandboxProvider (CRUD)      │                               │
│    .create()                 │                               │
│    .get() / .list()          │                               │
│    .destroy()                │                               │
│    .listFiles() / .readFile()│                               │
│    .exec()                   │                               │
└──────────────────────────────┼──────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────▼──────┐  ┌─────▼──────────┐     │
    │ Docker Container│  │ Daytona Sandbox │     │
    │                 │  │                 │     │
    │ headless        │  │ headless        │     │
    │ --mode=stream   │  │ --mode=stream   │     │
    │                 │  │                 │     │
    │ reads: server   │  │ reads: server   │     │
    │ writes: agent   │  │ writes: agent   │     │
    │                 │  │                 │     │
    │ ◄──► Hosted DS  │  │ ◄──► Hosted DS  │     │
    └─────────────────┘  └────────────────┘     │
                                                │
                         (same hosted stream)   │
```

---

## New Interfaces

### StreamConfig

```typescript
interface StreamConfig {
  /** Base URL of the durable streams service */
  url: string
  /** Service identifier */
  serviceId: string
  /** JWT secret for authorization */
  secret: string
}
```

### SessionBridge

```typescript
interface SessionBridge {
  /** Emit a server-originated event (visible to UI subscribers) */
  emit(event: EngineEvent): Promise<void>

  /** Send a command to the sandbox */
  sendCommand(cmd: Record<string, unknown>): Promise<void>

  /** Send a gate response to the sandbox */
  sendGateResponse(gate: string, value: Record<string, unknown>): Promise<void>

  /** Subscribe to agent-originated events */
  onAgentEvent(cb: (event: EngineEvent) => void): void

  /** Subscribe to session completion */
  onComplete(cb: (success: boolean) => void): void

  /** Full stream URL for SSE subscription */
  readonly streamUrl: string

  /** Close the bridge and release resources */
  close(): void
}
```

### SandboxProvider (revised)

```typescript
interface SandboxProvider {
  /** Provision a new sandbox, connect it to the session bridge */
  create(sessionId: string, opts: CreateSandboxOpts): Promise<SandboxHandle>

  /** Look up a sandbox by session ID */
  get(sessionId: string): SandboxHandle | undefined

  /** List all active sandboxes */
  list(): SandboxHandle[]

  /** Destroy a sandbox and release resources */
  destroy(handle: SandboxHandle): Promise<void>

  /** Restart the agent process inside the sandbox */
  restartAgent(handle: SandboxHandle): Promise<SandboxHandle>

  /** List files in the sandbox */
  listFiles(handle: SandboxHandle, dir: string): Promise<string[]>

  /** Read a file from the sandbox */
  readFile(handle: SandboxHandle, filePath: string): Promise<string | null>

  /** Execute a command in the sandbox */
  exec(handle: SandboxHandle, command: string): Promise<string>

  /** Start the dev server */
  startApp(handle: SandboxHandle): Promise<boolean>

  /** Stop the dev server */
  stopApp(handle: SandboxHandle): Promise<boolean>

  /** Check if the dev server is running */
  isAppRunning(handle: SandboxHandle): Promise<boolean>

  /** Get git status */
  gitStatus(handle: SandboxHandle, projectDir: string): Promise<GitStatus>

  /** Get a preview URL for a port (cloud runtimes only) */
  getPreviewUrl?(handle: SandboxHandle, port: number): Promise<string | null>

  /** Clone a repo into the sandbox */
  createFromRepo(
    sessionId: string,
    repoUrl: string,
    opts?: CreateFromRepoOpts,
  ): Promise<SandboxHandle>
}

interface SandboxHandle {
  sessionId: string
  port: number
  projectDir: string
  previewUrl?: string   // Cloud runtimes set this
  runtime: "docker" | "daytona"
}
```

---

## CRUD API

### Sandbox Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/sandboxes` | Create a new sandbox |
| `GET` | `/api/sandboxes` | List all active sandboxes |
| `GET` | `/api/sandboxes/:id` | Get sandbox status |
| `DELETE` | `/api/sandboxes/:id` | Destroy a sandbox |

### Request/Response

**POST /api/sandboxes**
```json
{
  "sessionId": "abc123",
  "runtime": "docker" | "daytona",
  "projectName": "my-app",
  "infra": { "mode": "local" } | { "mode": "cloud", ... }
}
```

Response (201):
```json
{
  "sessionId": "abc123",
  "runtime": "docker",
  "port": 54321,
  "projectDir": "/home/agent/workspace/my-app",
  "status": "running",
  "streamUrl": "https://api.electric-sql.cloud/v1/stream/svc-.../session/abc123"
}
```

**GET /api/sandboxes**
```json
{
  "sandboxes": [
    { "sessionId": "abc123", "runtime": "docker", "status": "running", ... },
    { "sessionId": "def456", "runtime": "daytona", "status": "running", ... }
  ]
}
```

**GET /api/sandboxes/:id**
```json
{
  "sessionId": "abc123",
  "runtime": "docker",
  "port": 54321,
  "projectDir": "/home/agent/workspace/my-app",
  "status": "running",
  "previewUrl": null
}
```

**DELETE /api/sandboxes/:id**
```json
{ "ok": true }
```

---

## Integration Testing Strategy

### Test Pipeline

```
1. Verify DS connectivity (curl-level)
2. Verify bridge roundtrip (write event, read event)
3. Verify Docker sandbox protocol (create, send command, receive events)
4. Verify Daytona sandbox protocol (create, send command, receive events)
```

### Test Sandbox Image

A minimal Docker image (`Dockerfile.test-sandbox`) that:
1. Connects to the hosted durable stream
2. Waits for a `source: "server", type: "command"` message
3. Echoes back a `source: "agent", type: "log"` event with the command contents
4. Sends `source: "agent", type: "session_complete"` and exits

This validates the full pipeline without running any AI agents.

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY test-sandbox/ .
RUN npm ci
CMD ["node", "index.js"]
```

The test script (`test-sandbox/index.js`):
```javascript
// Reads env: DS_URL, DS_SERVICE_ID, DS_SECRET, SESSION_ID
// Connects to stream, filters source=server, echoes back events
```

### Integration Test Phases

**Phase 1: Stream bridge test** (no containers)
```
- Create bridge for test session
- bridge.emit(logEvent) → verify it appears in stream
- bridge.sendCommand(cmd) → verify it appears in stream
- Subscribe and verify filtering works
```

**Phase 2: Docker sandbox test**
```
- Build test-sandbox image
- Create Docker sandbox with test image
- Send command via bridge
- Verify echo event received via bridge
- Verify session_complete
- Destroy sandbox, verify cleanup
```

**Phase 3: Daytona sandbox test**
```
- Create Daytona sandbox with test image
- Same protocol validation as Docker
- Verify preview URL generation
- Destroy sandbox
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DS_URL` | Yes | — | Durable Streams service URL |
| `DS_SERVICE_ID` | Yes | — | Service identifier |
| `DS_SECRET` | Yes | — | JWT bearer token |
| `DAYTONA_API_KEY` | No | — | Daytona API key (enables cloud runtime) |
| `DAYTONA_API_URL` | No | `https://app.daytona.io/api` | Daytona API endpoint |
| `DAYTONA_TARGET` | No | `us` | Daytona region |

---

## Migration Path

### Backward Compatibility

The stdio headless mode is preserved. Docker containers can run in either mode:
- **stdio mode** (default): Current behavior, container pipes stdout to local stream server
- **stream mode** (new): Container connects directly to hosted streams

The mode is selected by environment variables:
- If `DS_URL` + `DS_SERVICE_ID` + `DS_SECRET` + `SESSION_ID` are set → stream mode
- Otherwise → stdio mode (backward compatible)

### Incremental Rollout

1. **Phase 1**: Add stream config + bridge abstraction (no behavior change)
2. **Phase 2**: Add headless stream mode + test sandbox (opt-in via env vars)
3. **Phase 3**: Add DaytonaSandboxProvider (opt-in via DAYTONA_API_KEY)
4. **Phase 4**: Refactor server.ts to use bridge everywhere
5. **Phase 5**: Default new sessions to hosted streams

---

## File Layout (New/Modified)

```
src/
├── web/
│   ├── streams.ts              # NEW: Stream config (URL, auth, factory)
│   ├── bridge/                 # NEW: Session bridge abstraction
│   │   ├── types.ts            # SessionBridge interface
│   │   ├── hosted.ts           # HostedStreamBridge (hosted DS service)
│   │   └── local.ts            # LocalStreamBridge (local DS test server)
│   ├── sandbox/
│   │   ├── types.ts            # MODIFIED: Revised SandboxHandle + SandboxProvider
│   │   ├── docker.ts           # MODIFIED: Adapted for new interface
│   │   ├── daytona.ts          # NEW: DaytonaSandboxProvider
│   │   └── index.ts            # MODIFIED: Re-exports
│   ├── server.ts               # MODIFIED: Use bridge, add CRUD routes
│   ├── infra.ts                # MODIFIED: Optional (fallback for local dev)
│   └── container-bridge.ts     # DEPRECATED: Replaced by SessionBridge
├── engine/
│   └── headless-adapter.ts     # MODIFIED: Add stream mode
├── cli/
│   ├── headless.ts             # MODIFIED: Mode detection
│   └── serve.ts                # MODIFIED: Stream config + provider selection
tests/
├── scaffold.test.ts            # EXISTING
├── streams.test.ts             # NEW: Stream connectivity + bridge tests
├── docker-sandbox.test.ts      # NEW: Docker sandbox integration test
└── daytona-sandbox.test.ts     # NEW: Daytona sandbox integration test
test-sandbox/                   # NEW: Minimal test sandbox
├── package.json
├── index.js                    # Protocol echo script
└── Dockerfile                  # Test sandbox image
```
