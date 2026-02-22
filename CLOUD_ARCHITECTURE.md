# Cloud Runtime Architecture

## Overview

The cloud runtime architecture extends `create-electric-app` to support multiple sandbox providers (Docker, Daytona) with a **unified communication layer via hosted Durable Streams**. Both the web server and sandboxes connect to the same hosted stream — no stdout piping, local DS servers, or tunnels needed.

**All sandboxes run in `--stream` mode.** The local `DurableStreamTestServer` is removed. The React client receives events via a server-side SSE proxy (never sees DS credentials).

---

## Implementation Status

### Done (Phases 1-3)

- **Stream config module** (`src/web/streams.ts`) — `getStreamConfig()`, `getStreamConnectionInfo()`, `getStreamEnvVars()`, `isHostedStreams()`
- **SessionBridge abstraction** (`src/web/bridge/types.ts`) — interface with `emit()`, `sendCommand()`, `sendGateResponse()`, `onAgentEvent()`, `onComplete()`, `start()`, `close()`
- **HostedStreamBridge** (`src/web/bridge/hosted.ts`) — implementation using `@durable-streams/client`
- **SandboxProvider refactor** (`src/web/sandbox/types.ts`) — async methods, `isAlive()`, communication moved to bridge
- **SandboxHandle refactor** — removed `ChildProcess`, added `runtime: SandboxRuntime`, optional `previewUrl`
- **DockerSandboxProvider** (`src/web/sandbox/docker.ts`) — still has backward-compat `writeStdin()`/`getProcess()` (to be removed)
- **DaytonaSandboxProvider** (`src/web/sandbox/daytona.ts`) — full implementation using `@daytonaio/sdk`
- **CRUD API routes** in `server.ts` — `GET/POST/DELETE /api/sandboxes`
- **Headless stream adapter** (`src/engine/stream-adapter.ts`) — `createStreamAdapter()` for `--stream` mode
- **CLI `--stream` flag** (`src/index.ts`, `src/cli/headless.ts`) — mode detection and adapter selection
- **Test sandbox** (`Dockerfile.test-sandbox`, `tests/test-sandbox-agent.ts`) — echo agent for integration testing
- **Unit tests** (`tests/sandbox.test.ts`) — 15 tests covering both providers + Daytona API connectivity
- **Stream integration tests** (`tests/streams.test.ts`) — hosted stream read/write roundtrip

### Remaining (Phases 4-8)

See **Implementation Plan** section below.

---

## Key Design Decisions

### 1. Hosted Durable Streams Only (No Local DS Server)

The local `DurableStreamTestServer` and `infra.ts` are removed entirely. All environments (dev, prod) use the hosted Durable Streams service (`api.electric-sql.cloud`). `DS_URL`, `DS_SERVICE_ID`, `DS_SECRET` are required env vars.

### 2. Bidirectional Protocol on a Single Stream

Each session gets one durable stream. Messages are tagged with a `source` field:

```
source: "agent"   — events from the sandbox (engine events, tool results, etc.)
source: "server"  — commands and gate responses from the web server
```

### 3. Server-Side SSE Proxy

The React client subscribes to `/api/sessions/:id/events` — a server-side SSE endpoint. The server reads from the hosted stream and proxies events to the client. The client **never sees DS credentials or stream URLs**.

### 4. SandboxProvider as Pure CRUD

Communication (commands, gate responses, events) flows through the `SessionBridge`, not the provider. Providers only manage lifecycle + file/exec operations.

### 5. Unified Transport

Both Docker and Daytona sandboxes run `electric-agent headless --stream`. No runtime-specific communication branches in server.ts.

### 6. Docker Hub for Images

Sandbox images are pushed to Docker Hub. Daytona pulls from Docker Hub. A lightweight test image enables fast iteration without rebuilding the full sandbox.

---

## Stream Protocol

### Stream URL Pattern

```
{DS_URL}/v1/stream/{DS_SERVICE_ID}/session/{sessionId}
```

### Authentication

```
Authorization: Bearer {DS_SECRET}
```

### Message Format

```json
{ "source": "agent" | "server", "type": "...", "ts": "..." }
```

**Agent messages** (`source: "agent"`):
```json
{ "source": "agent", "type": "log", "level": "task", "message": "...", "ts": "..." }
{ "source": "agent", "type": "session_complete", "success": true, "ts": "..." }
```

**Server messages** (`source: "server"`):
```json
{ "source": "server", "type": "command", "command": "new", "description": "...", "ts": "..." }
{ "source": "server", "type": "gate_response", "gate": "approval", "decision": "approve", "ts": "..." }
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Web Browser (React SPA)                  │
│  subscribes to /api/sessions/:id/events (SSE)                │
│  POST /api/sessions/:id/respond → server writes gate_response│
└─────────────────────┬───────────────────────────────────────┘
                      │ HTTP / SSE
┌─────────────────────▼───────────────────────────────────────┐
│                   Hono Web Server                            │
│                                                              │
│  /api/sessions/:id/events (SSE proxy)                        │
│    reads from hosted stream, proxies to client               │
│    client never sees DS credentials                          │
│                                                              │
│  SessionBridge (per session)                                 │
│    .emit(event)         ◄──► Hosted Durable Streams          │
│    .sendCommand(cmd)         (api.electric-sql.cloud)        │
│    .sendGateResponse(...)         ▲                          │
│    .onAgentEvent(cb)              │                          │
│                                   │                          │
│  SandboxProvider (CRUD only)      │                          │
│    .create() / .destroy()         │                          │
│    .listFiles() / .readFile()     │                          │
│    .exec()                        │                          │
└───────────────────────────────────┼─────────────────────────┘
                                    │
               ┌────────────────────┼────────────────┐
               │                    │                │
     ┌─────────▼──────┐  ┌─────────▼──────────┐     │
     │ Docker Container│  │  Daytona Sandbox    │     │
     │                 │  │                     │     │
     │ headless        │  │ headless            │     │
     │ --stream        │  │ --stream            │     │
     │                 │  │                     │     │
     │ reads: server   │  │ reads: server       │     │
     │ writes: agent   │  │ writes: agent       │     │
     │                 │  │                     │     │
     │ ◄──► Hosted DS  │  │ ◄──► Hosted DS      │     │
     └─────────────────┘  └─────────────────────┘     │
                                                      │
                           (same hosted stream)       │
```

---

## Interfaces

### StreamConfig

```typescript
interface StreamConfig {
  url: string       // Base URL of the durable streams service
  serviceId: string // Service identifier
  secret: string    // JWT bearer token
}
```

### SessionBridge

```typescript
interface SessionBridge {
  readonly sessionId: string
  readonly streamUrl: string
  readonly streamHeaders: Record<string, string>

  emit(event: EngineEvent): Promise<void>
  sendCommand(cmd: Record<string, unknown>): Promise<void>
  sendGateResponse(gate: string, value: Record<string, unknown>): Promise<void>
  onAgentEvent(cb: (event: EngineEvent) => void): void
  onComplete(cb: (success: boolean) => void): void
  start(): Promise<void>
  close(): void
}
```

### SandboxProvider

```typescript
interface SandboxProvider {
  readonly runtime: SandboxRuntime

  create(sessionId: string, opts?: CreateSandboxOpts): Promise<SandboxHandle>
  destroy(handle: SandboxHandle): Promise<void>
  restartAgent(handle: SandboxHandle): Promise<SandboxHandle>
  get(sessionId: string): SandboxHandle | undefined
  list(): SandboxHandle[]
  isAlive(handle: SandboxHandle): boolean

  listFiles(handle: SandboxHandle, dir: string): Promise<string[]>
  readFile(handle: SandboxHandle, filePath: string): Promise<string | null>
  exec(handle: SandboxHandle, command: string): Promise<string>

  startApp(handle: SandboxHandle): Promise<boolean>
  stopApp(handle: SandboxHandle): Promise<boolean>
  isAppRunning(handle: SandboxHandle): Promise<boolean>

  gitStatus(handle: SandboxHandle, projectDir: string): Promise<GitStatus>
  getPreviewUrl?(handle: SandboxHandle, port: number): Promise<string | null>
  createFromRepo(sessionId: string, repoUrl: string, opts?: ...): Promise<SandboxHandle>
}

interface SandboxHandle {
  sessionId: string
  runtime: "docker" | "daytona"
  port: number
  projectDir: string
  previewUrl?: string
}
```

---

## CRUD API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/sandboxes` | Create a new sandbox |
| `GET` | `/api/sandboxes` | List all active sandboxes |
| `GET` | `/api/sandboxes/:id` | Get sandbox status |
| `DELETE` | `/api/sandboxes/:id` | Destroy a sandbox |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DS_URL` | Yes | — | Durable Streams service URL |
| `DS_SERVICE_ID` | Yes | — | Service identifier |
| `DS_SECRET` | Yes | — | JWT bearer token |
| `DOCKER_HUB_USER` | No | — | Docker Hub username (for image push) |
| `DAYTONA_API_KEY` | No | — | Daytona API key (enables cloud runtime) |
| `DAYTONA_API_URL` | No | `https://app.daytona.io/api` | Daytona API endpoint |
| `DAYTONA_TARGET` | No | `us` | Daytona region |

---

## File Layout (Target)

```
src/web/
├── streams.ts              # Stream config (URL, auth, env vars)
├── bridge/
│   ├── types.ts            # SessionBridge interface + message types
│   ├── hosted.ts           # HostedStreamBridge (hosted DS service)
│   └── index.ts            # Re-exports
├── sandbox/
│   ├── types.ts            # SandboxHandle, SandboxProvider, GitStatus
│   ├── docker.ts           # DockerSandboxProvider (no more writeStdin/getProcess)
│   ├── daytona.ts          # DaytonaSandboxProvider
│   └── index.ts            # Re-exports
└── server.ts               # Hono server — SSE proxy + SessionBridge for ALL communication

src/engine/
└── stream-adapter.ts       # Headless stream adapter (--stream mode, the only mode)

tests/
├── sandbox.test.ts         # Provider unit tests (always run)
├── streams.test.ts         # Stream bridge integration tests (always run)
├── e2e-docker.test.ts      # Docker end-to-end with test sandbox image
└── e2e-daytona.test.ts     # Daytona end-to-end (run separately: npm run test:daytona)

Dockerfile.sandbox          # Full sandbox image (electric-agent + deps)
Dockerfile.test-sandbox     # Minimal test image (echo agent only)
```

**Removed files:**
- `src/web/container-bridge.ts` — replaced by SessionBridge
- `src/web/infra.ts` — local DS server removed
- `src/engine/headless-adapter.ts` — stdio mode removed

---

## Implementation Plan

### Phase 4: Remove Local DS + SSE Proxy (Docker-focused)

**Goal:** Eliminate the local `DurableStreamTestServer`. All stream access goes through hosted DS. React client subscribes via a server-side SSE proxy.

**Steps:**

1. **Add SSE proxy endpoint to server.ts**
   - `GET /api/sessions/:id/events` — server-side SSE endpoint
   - Server reads from hosted stream (using `HostedStreamBridge.onAgentEvent()` or direct `DurableStream` subscription)
   - Proxies events to the client as SSE `data:` frames
   - Client never sees `DS_URL`/`DS_SECRET`

2. **Update React client (`useSession.ts`)**
   - Replace hardcoded `STREAMS_BASE = "http://127.0.0.1:4437"` with `EventSource` subscription to `/api/sessions/:id/events`
   - Remove `@durable-streams/client` dependency from the client bundle
   - Keep the same `processEvent()` reducer — only the transport changes

3. **Remove local DS server**
   - Delete `src/web/infra.ts` (`startStreamServer`, `stopStreamServer`, `getStreamServerUrl`)
   - Remove `startStreamServer()` / `stopStreamServer()` calls from `src/cli/serve.ts`
   - Remove `--streams-port` CLI option from `serve.ts`
   - Remove `streamsPort` parameter threading through `createApp()` and all routes
   - Require `DS_URL` + `DS_SERVICE_ID` + `DS_SECRET` at startup (fail fast if missing)

4. **Update server.ts stream creation**
   - Replace `DurableStream.create({ url: getStreamServerUrl(...) })` with `getStreamConnectionInfo()` from `streams.ts`
   - All stream writes use the hosted URL + auth headers

5. **Test:** Verify React client can subscribe to SSE proxy and receive events from a manually-written stream message.

### Phase 5: Docker Bridge Integration

**Goal:** Replace all Docker stdin/stdout/container-bridge communication with `SessionBridge`. Docker containers run in `--stream` mode.

**Steps:**

1. **Add bridge registry to server.ts**
   - `Map<string, SessionBridge>` — created per session, closed on destroy
   - On session creation: `new HostedStreamBridge(sessionId, connectionInfo)` → `bridge.start()`
   - `bridge.onAgentEvent(cb)` replaces `bridgeContainerToStream()` for event forwarding
   - `bridge.onComplete(cb)` replaces container process exit handler

2. **Update Docker container startup**
   - `generateComposeFile()`: add DS env vars (`DS_URL`, `DS_SERVICE_ID`, `DS_SECRET`, `SESSION_ID`) to agent service
   - Change command from `electric-agent headless` to `electric-agent headless --stream`
   - Remove `stdin_open: true` from compose, remove stdio pipe from `docker compose run`
   - Keep `composeDir`/`composeProject` in internal state for lifecycle management

3. **Refactor command/gate routes**
   - Replace `dockerSandbox.writeStdin(handle, JSON.stringify(...))` with `bridge.sendCommand()` / `bridge.sendGateResponse()`
   - Remove Docker-specific cast (`config.sandbox as DockerSandboxProvider`)
   - All gates go through the bridge (remove `serverGates` set)

4. **Remove deprecated code**
   - Delete `src/web/container-bridge.ts`
   - Remove `writeStdin()`, `getProcess()`, `DockerInternalState.process` from `docker.ts`
   - Delete `src/engine/headless-adapter.ts` (stdio adapter)
   - Remove `headless-adapter.ts` import from `headless.ts` — `--stream` becomes the only mode

5. **Handle app_ready detection**
   - Current container-bridge detects Vite `ready` from stderr → emits `app_ready` event
   - Move this to the headless stream adapter: the agent process monitors its own child Vite process stderr and emits `app_ready` via the stream
   - OR: use `isAppRunning()` polling from the server side (simpler)

6. **Test:** End-to-end with test sandbox image (see Phase 7).

### Phase 6: Daytona Integration

**Goal:** Wire Daytona as an alternative provider. Since both runtimes use the same bridge, this is mostly plumbing.

**Steps:**

1. **Provider selection in `serve.ts`**
   - If `DAYTONA_API_KEY` is set → `DaytonaSandboxProvider`
   - Otherwise → `DockerSandboxProvider`
   - Pass provider to `createApp()` (already the pattern)

2. **Daytona sandbox env vars**
   - Pass DS credentials + `SESSION_ID` to Daytona sandbox via `create()` env vars
   - Daytona sandbox runs `electric-agent headless --stream` on boot (already configured in `daytona.ts`)

3. **Preview URL support**
   - Add `previewUrl` to session info API response
   - Wire `getPreviewUrl()` to UI

### Phase 7: Image Build + Registry Push

**Goal:** Build and push sandbox images to Docker Hub so Daytona can pull them. Use a lightweight test image for fast iteration.

**Steps:**

1. **Test image (`Dockerfile.test-sandbox`)**
   - Minimal Node.js image with the echo agent (`test-sandbox-agent.ts`)
   - Supports `--stream` mode only (reads commands from hosted stream, echoes back)
   - Fast to build (~seconds), small image
   - Used for all integration tests

2. **Docker Hub push scripts**
   - `npm run push:test-sandbox` — build + push test image to Docker Hub (`$DOCKER_HUB_USER/electric-agent-test-sandbox:latest`)
   - `npm run push:sandbox` — build + push full sandbox image to Docker Hub (`$DOCKER_HUB_USER/electric-agent-sandbox:latest`)
   - Both scripts: `docker build` → `docker tag` → `docker push`

3. **Update `daytona.ts` image reference**
   - Change `SANDBOX_IMAGE` from `"electric-agent-sandbox"` to `"$DOCKER_HUB_USER/electric-agent-sandbox:latest"` (configurable via env var)

4. **Test image upload + Daytona pull**
   - Push test image to Docker Hub
   - Create Daytona sandbox with test image
   - Verify it starts, connects to hosted stream, echoes commands
   - This validates the full registry → Daytona → stream pipeline

### Phase 8: End-to-End Testing

**Goal:** Validate the full protocol for both runtimes.

**Test structure:**

1. **`tests/sandbox.test.ts`** (existing, `npm test`)
   - Provider interface conformance, unit tests

2. **`tests/streams.test.ts`** (existing, `npm test`)
   - HostedStreamBridge roundtrip, source filtering

3. **`tests/e2e-docker.test.ts`** (new, `npm test`)
   - Build test sandbox image locally
   - Create Docker sandbox with DS env vars → runs `headless --stream`
   - Send command via bridge → verify echo response
   - Verify `session_complete` event
   - Destroy sandbox, verify cleanup
   - Skip if Docker not available

4. **`tests/e2e-daytona.test.ts`** (new, `npm run test:daytona`)
   - Requires `DAYTONA_API_KEY` — **separate test command**, never runs in `npm test`
   - Push test image to Docker Hub (or assume pre-pushed)
   - Create Daytona sandbox with test image + DS env vars
   - Same protocol validation as Docker test
   - Verify preview URL generation
   - Destroy sandbox

**npm scripts:**
```json
{
  "test": "tsx --test tests/sandbox.test.ts tests/streams.test.ts tests/e2e-docker.test.ts",
  "test:daytona": "tsx --test tests/e2e-daytona.test.ts",
  "push:test-sandbox": "docker build -f Dockerfile.test-sandbox -t $DOCKER_HUB_USER/electric-agent-test-sandbox . && docker push $DOCKER_HUB_USER/electric-agent-test-sandbox",
  "push:sandbox": "docker build -f Dockerfile.sandbox -t $DOCKER_HUB_USER/electric-agent-sandbox . && docker push $DOCKER_HUB_USER/electric-agent-sandbox"
}
```
