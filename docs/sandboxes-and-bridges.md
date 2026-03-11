# Sandboxes & Bridges

Every agent session runs inside an isolated **sandbox**. The server communicates with the sandbox through a **bridge** — an abstraction that handles bidirectional event streaming between the Hono server and the Claude Code process.

## Sandbox Providers

Two sandbox runtimes are supported, selected via the `SANDBOX_RUNTIME` environment variable:

| Runtime | Provider | Use Case |
|---------|----------|----------|
| `docker` | `DockerSandboxProvider` | Local development. Requires Docker daemon on the host. |
| `sprites` | `SpritesSandboxProvider` | Production. Fly.io cloud micro-VMs. |

### SandboxProvider Interface

All providers implement the same interface:

```typescript
interface SandboxProvider {
  create(config): Promise<Sandbox>
  destroy(sandboxId): Promise<void>
  exec(sandboxId, command): Promise<ExecResult>
  listFiles(sandboxId, path): Promise<string[]>
  readFile(sandboxId, path): Promise<string>
  gitStatus(sandboxId): Promise<GitStatus>
  startApp(sandboxId): Promise<void>
  stopApp(sandboxId): Promise<void>
}
```

### Docker (`docker`)

- Spawns a container from the `electric-agent-sandbox` image.
- Includes Postgres + Electric + Caddy via docker compose.
- Port-maps the generated app's dev server to the host.
- Communicates via `docker exec` + stream-json pipes.

Build the sandbox image:

```bash
pnpm run build:sandbox    # builds electric-agent-sandbox Docker image
```

### Sprites (`sprites`)

- Creates Fly.io micro-VMs via the Sprites REST API.
- Sets network policy and public URL access.
- Each VM gets a preview URL: `https://<sprite-name>.sprites.app`.
- Only port 8080 is exposed externally.
- Communicates via SSH + stream-json.

### Sandbox Credentials

Sandboxes receive only the credentials they need to run the agent:

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | Claude API access |
| `GH_TOKEN` | GitHub operations |
| `DATABASE_URL` | Postgres connection |
| `ELECTRIC_URL` / `ELECTRIC_SECRET` / `ELECTRIC_SOURCE_ID` | Electric sync service |

Sandboxes do **not** receive Durable Streams credentials (`DS_SECRET`, `DS_URL`, `DS_SERVICE_ID`). All stream access is proxied through the studio server. See [Security](./security.md#credential-isolation).

## Bridge Modes

Bridges connect the server to the agent process running inside the sandbox. All bridges run **server-side** — they are part of the studio server process, not the sandbox. The bridge mode determines how events flow:

| Mode | Bridge Class | How It Works |
|------|-------------|-------------|
| `stream` | `HostedStreamBridge` | Both server and agent read/write the same Durable Stream. No stdin/stdout piping. |
| `claude-code` | `ClaudeCodeDockerBridge` / `ClaudeCodeSpritesBridge` | Spawns `claude` CLI with stream-json I/O inside the sandbox. Bridge parses stdout and writes events to the Durable Stream. |

### SessionBridge Interface

```typescript
interface SessionBridge {
  readonly sessionId: string

  start(): Promise<void>
  close(): void
  interrupt(): void
  isRunning(): boolean

  emit(event: EngineEvent): Promise<void>          // Server → Stream
  sendCommand(cmd: Record<string, unknown>): Promise<void>  // User iteration → Agent
  sendGateResponse(gate: string, value: Record<string, unknown>): Promise<void>  // Gate resolution → Agent
  onAgentEvent(cb: (event: EngineEvent) => void): void      // Agent → UI streaming
  onComplete(cb: (success: boolean) => void): void           // Session end notification
}
```

DS credentials (stream URL, auth headers) are internal to each bridge implementation. They are not exposed on the `SessionBridge` interface.

### HostedStreamBridge (`stream`)

Both the server and the agent write directly to the same Durable Stream. The server subscribes to the stream and proxies events to the browser via SSE. This is the simplest mode — no stdin/stdout piping.

```
Agent ──writes──→ Durable Stream ←──reads── Server ──SSE──→ Browser
```

### ClaudeCodeBridge (`claude-code`)

Spawns the `claude` CLI inside the sandbox with `--output-format stream-json`. The bridge:

1. Parses the JSON stream from stdout.
2. Translates Claude Code events into `EngineEvent` types.
3. Writes events to the Durable Stream.
4. Forwards iteration commands and gate responses to stdin.

Supports `--resume` for continuing conversations across reconnections. Captures the Claude Code session ID for resumption.

```
Server                          Sandbox
  │                               │
  ├── spawn claude CLI ──────────→│
  │                               ├── claude --output-format stream-json
  │                               │         │
  │←── stdout (JSON stream) ──────┤         ├── tool calls, messages
  │                               │         │
  ├── stdin (commands/gates) ────→│         └── reads/writes files
  │                               │
```

## Session Lifecycle

1. **Create**: `POST /api/sessions` → server creates a Durable Stream, emits `infra_config_prompt` gate, waits for user to select infrastructure mode.

2. **Provision**: Gate resolved → server creates sandbox via the selected provider, creates a bridge.

3. **Start**: Bridge spawns the agent process. Events begin streaming.

4. **Iterate**: User sends follow-up instructions via `POST /api/sessions/:id/iterate` → bridge forwards to agent stdin.

5. **Gates**: Agent emits blocking events (plan approval, clarification) → server pauses → user resolves via web UI → bridge forwards response.

6. **End**: Agent emits `session_end` → bridge closes → sandbox remains available for iteration.

7. **Destroy**: User deletes session → sandbox is destroyed, Durable Stream remains for replay.

## Environment Variables

### Required (Server Only)

| Variable | Purpose |
|----------|---------|
| `DS_URL` | Durable Streams API URL |
| `DS_SERVICE_ID` | Durable Streams service ID |
| `DS_SECRET` | Durable Streams JWT secret (also used for token derivation) |

These credentials stay exclusively in the studio server process. They are never passed to sandboxes.

### Provider-Specific

| Variable | Provider | Purpose |
|----------|----------|---------|
| `SANDBOX_RUNTIME` | All | Which provider to use: `docker` or `sprites` |
| `FLY_API_TOKEN` | Sprites | Fly.io Sprites API authentication |

### Agent Credentials (Passed to Sandbox)

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API key |
| `CLAUDE_CODE_OAUTH_TOKEN` | Alternative Claude OAuth token |
| `GH_TOKEN` | GitHub operations inside sandbox |
