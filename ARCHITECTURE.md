# create-electric-app — Architecture Reference

## Overview

A multi-layered system that takes natural-language descriptions and generates fully functional, reactive Electric SQL + TanStack DB applications. It operates as both a CLI tool (`electric-agent headless`) and a web UI (`electric-agent serve`), using AI agents via the Anthropic Claude Agent SDK to plan, scaffold, and code the target app inside Docker sandboxes.

---

## Entry Points

| Command | File | Purpose |
|---------|------|---------|
| `electric-agent headless` | `src/cli/headless.ts` | NDJSON stdin/stdout protocol, used inside Docker containers |
| `electric-agent headless --stream` | `src/cli/headless.ts` | Durable Stream protocol, used inside Daytona sandboxes |
| `electric-agent serve` | `src/cli/serve.ts` | Starts Hono web server + DurableStream server + React SPA |

Both are registered in `src/index.ts` via Commander.js.

---

## Core Abstractions

### 1. Engine Layer (the heart)

**`OrchestratorCallbacks`** (`src/engine/orchestrator.ts`) — Inverts I/O. The orchestrator never knows if it's running in CLI, web, or test mode:
```
onEvent(event)                    → fire-and-forget event emission
onClarificationNeeded(questions)  → gate: pauses until answers arrive
onPlanReady(plan)                 → gate: pauses until approve/revise/cancel
onRevisionRequested()             → gate: pauses until feedback text
onContinueNeeded()                → gate: pauses until yes/no
```

**`EngineEvent`** (`src/engine/events.ts`) — 18-type discriminated union. Single source of truth for all events:
- Logging: `log`, `user_message`, `assistant_text`, `assistant_thinking`
- Tool tracking: `tool_start`, `tool_result`
- Gates: `clarification_needed`, `plan_ready`, `continue_needed`, `publish_prompt`, `checkpoint_prompt`, `infra_config_prompt`, `repo_setup_prompt`, `gate_resolved`
- Lifecycle: `phase_complete`, `session_complete`, `app_ready`, `cost_update`, `git_checkpoint`

**`sdkMessageToEvents()`** (`src/engine/message-parser.ts`) — Converts raw Claude Agent SDK messages into `EngineEvent[]`.

### 2. Headless Adapters

Two adapters provide the same `readConfig/waitForCommand/callbacks/close` interface but use different transports:

| Adapter | File | Transport | When used |
|---------|------|-----------|-----------|
| Stdin/Stdout | `src/engine/headless-adapter.ts` | NDJSON over stdin/stdout | Docker containers (default) |
| Stream | `src/engine/stream-adapter.ts` | Hosted Durable Stream | Daytona sandboxes (`--stream` flag) |

**Stdin protocol** (controller → agent):
- Line 1 = JSON config `{"command":"new",...}`, Lines 2+ = gate responses or new commands
- Agent → controller: One `EngineEvent` JSON per line (NDJSON)

**Stream protocol** — bidirectional on a single durable stream:
- Server writes: `{ source: "server", type: "command", ... }` or `{ source: "server", type: "gate_response", gate: "...", ... }`
- Agent writes: `{ source: "agent", type: "tool_start", ... }` etc.
- Each side filters messages by `source` field

### 3. Gate Mechanism

Two implementations, same concept — a Promise that blocks until an external event resolves it:

| Context | Implementation | How it resolves |
|---------|---------------|-----------------|
| Headless/container | `StdinReader.waitFor(gateName)` | Matching JSON line arrives on stdin |
| Web server | `createGate(sessionId, gateName)` in `src/web/gate.ts` | `POST /api/sessions/:id/respond` calls `resolveGate()` |

Server-side gates: `checkpoint`, `publish`, `infra_config`, `repo_setup`
Container-forwarded gates: `clarification`, `approval`, `continue`, `revision`

### 4. Durable Streams

Two modes:

| Mode | Config | Stream URL pattern |
|------|--------|--------------------|
| **Local** | `@durable-streams/server` at port 4437 | `http://localhost:4437/session/{id}` |
| **Hosted** | `DS_URL` + `DS_SERVICE_ID` + `DS_SECRET` env vars | `{DS_URL}/v1/stream/{DS_SERVICE_ID}/session/{id}` |

Stream configuration is centralized in `src/web/streams.ts`:
- `getStreamConfig()` reads env vars, returns null if not configured (falls back to local)
- `getStreamConnectionInfo(sessionId)` builds the full URL + auth headers
- `getStreamEnvVars(sessionId)` generates env vars to pass to sandboxes

Enables:
- Real-time push via SSE subscription
- Catch-up on reconnect via offset tracking
- Full session replay after completion

### 5. Session Bridge

**`SessionBridge`** (`src/web/bridge/types.ts`) — Abstracts bidirectional communication between server and sandbox:

```
emit(event)             → write server event to stream
sendCommand(cmd)        → write command to stream
sendGateResponse(gate)  → write gate response to stream
onAgentEvent(cb)        → subscribe to agent events from stream
onComplete(cb)          → fires when session_complete arrives
```

**`HostedStreamBridge`** (`src/web/bridge/hosted.ts`) — Implementation backed by hosted Durable Streams. Both server and sandbox connect to the same stream; messages are tagged with `source: "server"` or `source: "agent"` and each side filters by source.

---

## Agent System

All agents use `query()` from `@anthropic-ai/claude-agent-sdk` with async generators for streaming input.

| Agent | File | Model | Max Turns | Budget | Tools |
|-------|------|-------|-----------|--------|-------|
| **Clarifier** | `src/agents/clarifier.ts` | sonnet (evaluate) / haiku (name) | 1 | — | None |
| **Planner** | `src/agents/planner.ts` | sonnet | 10 | — | `read_playbook`, `list_playbooks`, `WebSearch` |
| **Coder** | `src/agents/coder.ts` | sonnet | 200 | $25.00 | Read/Write/Edit/Glob/Grep/Bash/WebSearch + MCP build/playbooks |
| **Git Agent** | `src/agents/git-agent.ts` | haiku | 5 | $0.25 | 9 git MCP tools |

**Session resumption**: The coder returns a `session_id` from the SDK. Stored in `SessionInfo.lastCoderSessionId` and passed as `{ resume: sessionId }` on subsequent runs, preserving full conversation context.

**System prompts** (`src/agents/prompts.ts`):
- `buildCoderPrompt(projectDir)` — 130-line prompt: Drizzle Workflow order, parallel tool calls, SSR rules, ARCHITECTURE.md format, file edit rules
- `buildPlannerPrompt()` — 6-phase plan structure with exact schema format
- `buildGitAgentPrompt(projectDir)` — Conventional commits + git workflow

---

## Tool System (MCP)

Tools are created with `tool()` from the Agent SDK and grouped into MCP servers via `createSdkMcpServer()`. Referenced as `mcp__<server-name>__<tool-name>` in `allowedTools`.

| Server | File | Tools |
|--------|------|-------|
| `electric-agent-tools` | `src/tools/server.ts` | `build`, `read_playbook`, `list_playbooks` |
| `git-tools` | `src/tools/git-server.ts` | `git_status`, `git_diff_summary`, `git_diff`, `git_commit`, `git_init`, `git_push`, `gh_repo_create`, `gh_pr_create`, `git_checkout` |

**Build tool** (`src/tools/build.ts`): Runs `pnpm build` → `pnpm check` → `pnpm test` sequentially, returns structured `{ success, output, errors }`.

**Playbook tools** (`src/tools/playbook.ts`): Scans npm packages (`@electric-sql/playbook`, `@tanstack/db-playbook`, `@durable-streams/playbook`) + bundled `playbooks/` for SKILL.md files with YAML frontmatter. `validatePlaybooks()` fails fast if required skills are missing.

---

## Hooks System

Hooks intercept Claude Agent SDK tool calls at `PreToolUse` and `PostToolUse` without the agent knowing.

| Hook | File | Stage | What it does |
|------|------|-------|-------------|
| `guardrailInject` | `src/hooks/guardrail-inject.ts` | `SessionStart` | Injects `electric-app-guardrails` + `ARCHITECTURE.md` as XML context |
| `writeProtection` | `src/hooks/write-protection.ts` | `PreToolUse[Write\|Edit]` | Denies writes to config files (docker-compose, vite.config, etc.) |
| `importValidation` | `src/hooks/import-validation.ts` | `PreToolUse[Write\|Edit]` | Blocks hallucinated imports, enforces correct package paths |
| `migrationValidation` | `src/hooks/migration-validation.ts` | `PreToolUse[Bash]` | Auto-appends `REPLICA IDENTITY FULL` to migration SQL |
| `dependencyGuard` | `src/hooks/dependency-guard.ts` | `PreToolUse[Write\|Edit]` | Prevents removal of existing package.json dependencies |
| `schemaConsistency` | `src/hooks/schema-consistency.ts` | `PostToolUse[Write\|Edit]` | Warns on `z.coerce.date()`, wrong zod import, missing `.default()` |
| `blockBash` | Inline in `src/hooks/index.ts` | `PreToolUse[Bash\|Write\|Edit]` | Planner-only: silently denies all file operations |

Hooks return `{ hookSpecificOutput: { permissionDecision: "deny" } }` to block a tool call.

---

## Scaffold System

`scaffold(projectDir, opts)` in `src/scaffold/index.ts` performs 12 steps:

1. Clone KPB template via `npx gitpick KyleAMathews/kpb`
2. Copy `template/` overlay (docker-compose, drizzle config, db stubs, electric proxy)
3. Merge dependencies into package.json (TanStack DB, Electric, Drizzle, drizzle-zod, vitest, etc.)
4. Delete stale pnpm-lock.yaml
5. Patch `vite.config.ts` — configurable port via `VITE_PORT`, `host: true`, proxy for `/v1/shape`
6. Fix public CSS imports (Rollup can't resolve absolute public-dir paths)
7. Copy `.env.example` → `.env`
8. Create `_agent/` working memory directory (errors.md, session.md)
9. Patch `.gitignore`
10. `pnpm install` (falls back to npm)
11. `git init -b main` + initial commit

---

## Web UI Architecture

### Server (`src/web/server.ts`)

Hono REST API with 20+ endpoints. Key patterns:

- **Session creation** is async: returns `{ sessionId, streamUrl }` immediately (201), then launches background flow: wait for infra gate → create Docker sandbox → bridge container stdout → optionally emit `repo_setup_prompt` gate (if GitHub accounts exist) → send "new" command
- **Iterate** detects app lifecycle commands (start/stop/restart) and handles them directly via `sandbox.startApp()`/`stopApp()` without invoking the agent
- **Git operations** (checkpoint/publish/PR) send `{ command: "git", gitTask: "..." }` to the container, letting the git agent handle it inside

### Container Bridge (`src/web/container-bridge.ts`)

Reads container stdout line-by-line, parses as `EngineEvent` JSON, appends to `DurableStream`. Classifies stderr (infra/Vite messages as info, others as error). Detects `VITE v*.* ready` to emit `app_ready`.

### Sandbox Provider (`src/web/sandbox/`)

`SandboxProvider` interface (`src/web/sandbox/types.ts`) abstracts sandbox management as pure CRUD + operations. Communication (commands, gate responses) flows through `SessionBridge`, NOT through the provider.

| Provider | File | Runtime | Communication |
|----------|------|---------|---------------|
| `DockerSandboxProvider` | `src/web/sandbox/docker.ts` | Docker containers | NDJSON stdin/stdout (via `writeStdin()` + container-bridge) |
| `DaytonaSandboxProvider` | `src/web/sandbox/daytona.ts` | Daytona cloud sandboxes | Hosted Durable Stream (via `SessionBridge`) |
| `SpritesSandboxProvider` | `src/web/sandbox/sprites.ts` | Fly.io Sprites micro-VMs | Stdio bridge over Sprites session (via `SpritesStdioBridge`) |

**CRUD API** (`/api/sandboxes`):
- `GET /api/sandboxes` — list all active sandboxes
- `GET /api/sandboxes/:sessionId` — get sandbox status
- `POST /api/sandboxes` — create standalone sandbox
- `DELETE /api/sandboxes/:sessionId` — destroy sandbox

**Docker** (`DockerSandboxProvider`):
- **create()**: `findFreePort()` → generate docker-compose.yml → start postgres+electric (local mode) → `docker compose run agent`
- Internal `ChildProcess` stored in private state (not exposed in handle)
- **File access**: `docker exec find/cat`
- **Auth**: tries `ANTHROPIC_API_KEY` → `CLAUDE_CODE_OAUTH_TOKEN` → macOS Keychain

**Daytona** (`DaytonaSandboxProvider`):
- **create()**: `resolveSnapshot()` → `daytona.create({ snapshot, envVars, labels })` → get preview URL
- **Snapshot flow** (`daytona-registry.ts`): On first sandbox creation, `ensureSnapshot()` checks if a snapshot exists. If not, it gets transient push credentials via `DockerRegistryApi.getTransientPushAccess()`, pushes the local image, and creates a snapshot. Subsequent creates in the same server session reuse the cached snapshot name.
- **Image build**: `push:sandbox:daytona` script builds linux/amd64 (Daytona requires x86), pushes to transient registry, creates snapshot — all in one command
- **File access**: `sandbox.process.executeCommand()` / `sandbox.fs.downloadFile()`
- **Preview**: `sandbox.getPreviewLink(port)` for accessible URLs
- Requires `DAYTONA_API_KEY` env var. Optional: `DAYTONA_API_URL` (default: `https://app.daytona.io/api`), `DAYTONA_TARGET` (default: `eu`)

### React Client (`src/web/client/`)

- **Router**: `/` (HomePage) and `/session/:id` (SessionPage)
- **`useSession()`** hook: subscribes to DurableStream, reduces `EngineEvent` → `ConsoleEntry[]`, tracks `isComplete`, `appReady`, `totalCost`
- **GatePrompt**: Renders different UI per gate type (clarification form, plan markdown, publish form, etc.), all POSTing to `/api/sessions/:id/respond`
- **Layout**: `AppShell` with collapsible sidebar + session list; `SessionPage` with resizable split pane (console left, file tree + viewer right)

---

## Working Memory

| File | Location | Purpose |
|------|----------|---------|
| `session.md` | `<projectDir>/_agent/` | Phase, task, build status — updated at milestones |
| `errors.md` | `<projectDir>/_agent/` | Error log with dedup — coder checks before retrying fixes |

`consecutiveIdenticalFailures()` compares last two errors to trigger escalation.

---

## Complete Data Flow: User → Generated App

```
User types "build a todo app" in browser
  → POST /api/sessions { description }
  → Server creates DurableStream + SessionInfo
  → Emits infra_config_prompt gate → user selects "Local Docker"
  → DockerSandboxProvider.create():
      postgres:17 + electricsql/electric + agent container
  → bridgeContainerToStream(stdout → DurableStream)
  → (if GitHub accounts exist) emit repo_setup_prompt → user configures repo
  → sendCommand({ command: "new", description })
  → Container headlessCommand() reads config from stdin
  → runNew():
      evaluateDescription() → confidence 85% → skip clarification
      scaffold() → clone KPB + overlay + install
      runPlanner() → Sonnet reads playbooks → outputs PLAN.md
      emit plan_ready → user clicks Approve → gate resolves
      runCoder() → Sonnet executes PLAN.md (200 turns):
        hooks auto-fix: REPLICA IDENTITY FULL, import validation
        writes schema → migrations → collections → routes → UI
        runs build tool → passes
        writes ARCHITECTURE.md
      runGitAgent() → Haiku commits: "feat: build todo app"
      emit session_complete
  → Bridge fires onComplete → session status = "complete"
  → Client: toast("Session completed"), Preview button appears
  → User clicks Preview → http://localhost:{mappedPort}
```

---

## Flow Diagram

```mermaid
flowchart TD
    Start([User runs<br/>'electric-agent new']) --> Clarify

    subgraph "Phase 0 — Clarification"
        Clarify["evaluateDescription (Sonnet)<br/>+ inferProjectName (Haiku)<br/><i>parallel</i>"]
        Clarify --> ConfCheck{Confidence<br/>≥ 50%?}
        ConfCheck -- Yes --> Scaffold
        ConfCheck -- No --> Gate1[/"Gate: onClarificationNeeded<br/>User answers questions"/]
        Gate1 --> Enrich["Enrich description<br/>with answers"]
        Enrich --> Scaffold
    end

    subgraph "Phase 1 — Scaffold"
        Scaffold["Clone KPB template<br/>Overlay files<br/>Merge deps<br/>pnpm install"]
        Scaffold --> ValidatePlaybooks["Validate playbooks"]
    end

    ValidatePlaybooks --> Planner

    subgraph "Phase 2 — Planning"
        Planner["Planner Agent (Sonnet)<br/>Tools: list_playbooks, read_playbook<br/>Hooks: block Bash/Write<br/>Max 10 turns"]
        Planner --> PlanOut["Generates PLAN.md"]
        PlanOut --> Gate2[/"Gate: onPlanReady"/]
        Gate2 --> Decision{User decision}
        Decision -- Approve --> WritePlan
        Decision -- Revise --> Feedback["Get revision feedback"]
        Feedback --> Planner
        Decision -- Cancel --> Cancelled([Cancelled])
    end

    WritePlan["Write PLAN.md<br/>+ init session state"] --> Coder

    subgraph "Phase 3 — Code Generation"
        Coder["Coder Agent (Sonnet)<br/>Tools: Read, Write, Edit, Glob,<br/>Grep, Bash, WebSearch,<br/>build, read_playbook<br/>Max 200 turns · $25 budget"]
        Coder --> CoderResult{Stop reason?}
        CoderResult -- complete --> GitCommit
        CoderResult -- error --> Failed([Failed])
        CoderResult -- "max_turns /<br/>max_budget" --> Gate3[/"Gate: onContinueNeeded"/]
        Gate3 --> ContDecision{Continue?}
        ContDecision -- Yes --> Resume["Resume coder<br/>(same sessionId)"]
        Resume --> Coder
        ContDecision -- No --> Paused([Paused —<br/>resume with iterate])
    end

    subgraph "Phase 4 — Auto-Commit"
        GitCommit["Git Agent (Haiku)<br/>git_diff_summary → git_commit<br/>Max 5 turns · $0.25"]
        GitCommit --> Done([Success])
    end

    subgraph "Guardrail Hooks"
        direction LR
        H1["PreToolUse: Write/Edit"]
        H2["PreToolUse: Bash"]
        H3["PostToolUse: Write/Edit"]
        H1 -.- H1a["write-protection<br/>import-validation<br/>dependency-guard"]
        H2 -.- H2a["migration-validation"]
        H3 -.- H3a["schema-consistency"]
    end

    style Gate1 fill:#fff3cd,stroke:#ffc107
    style Gate2 fill:#fff3cd,stroke:#ffc107
    style Gate3 fill:#fff3cd,stroke:#ffc107
    style Done fill:#d4edda,stroke:#28a745
    style Failed fill:#f8d7da,stroke:#dc3545
    style Cancelled fill:#f8d7da,stroke:#dc3545
    style Paused fill:#cce5ff,stroke:#007bff
```

---

## Sprites Sandbox Architecture

Sprites are cloud micro-VMs managed by Fly.io via the `@fly/sprites` SDK. They serve as the primary cloud sandbox runtime for deployed environments (e.g., on Fly.io). Unlike Docker (local) or Daytona (snapshot-based), Sprites are lightweight VMs that boot from scratch and use a checkpoint mechanism for fast subsequent starts.

### Sprite Lifecycle

1. **Create** — `SpritesSandboxProvider.create()` calls `client.createSprite(name, { ramMB, cpus, region })`. Default: 2 GB RAM, 2 CPUs, `ord` region. Sprite names follow the pattern `ea-{sessionId first 12 chars}`.
2. **Network policy** — Immediately after creation, a REST API call sets the network policy to allow all outbound connections (the JS SDK doesn't expose this yet).
3. **Bootstrap / Checkpoint restore** — `ensureBootstrapped(sprite)` checks for a `"bootstrapped"` checkpoint:
   - **If checkpoint exists**: Restores from it (instant — skips all install steps).
   - **If no checkpoint**: Runs full bootstrap, then creates the checkpoint for future reuse.
4. **Environment injection** — Writes env vars to `/etc/profile.d/electric-agent.sh` (see below).
5. **Agent start** — The bridge or server starts the `electric-agent headless` process.
6. **Destroy** — `sprite.delete()` tears down the VM.

### Bootstrap Process (`src/web/sandbox/sprites-bootstrap.ts`)

Sprites run Ubuntu 24.04 with Node.js (via nvm) pre-installed but no project tooling. Bootstrap installs:

1. `pnpm` (global npm install)
2. `electric-agent` (global npm install)
3. Creates `/home/agent/workspace/` directory
4. Writes `/etc/profile.d/npm-global.sh` — a profile script that adds the npm global bin and nvm paths to `$PATH` so commands run via `execFile("bash", ["-c", ...])` can find `node`, `npm`, and globally-installed binaries.
5. Configures git identity (`electric-agent` / `agent@electric-sql.com`, default branch `main`)

After bootstrap completes, `sprite.createCheckpoint("bootstrapped")` snapshots the VM state. Subsequent sprites restore from this checkpoint instantly instead of re-running the install steps.

### Environment Variables

All env vars are written to `/etc/profile.d/electric-agent.sh` as `export KEY="value"` lines (base64-encoded to avoid shell quoting issues in `execFile`). The agent process sources this file at startup.

| Variable | When set | Purpose |
|----------|----------|---------|
| `SANDBOX_MODE` | Always | Signals headless mode |
| `VITE_PORT` | Always | Dev server port (5173) |
| `DATABASE_URL` | Cloud/claim infra | Postgres connection string |
| `ELECTRIC_URL` | Cloud/claim infra | Electric sync endpoint |
| `ELECTRIC_SOURCE_ID` | Cloud/claim infra | Electric source identifier |
| `ELECTRIC_SECRET` | Cloud/claim infra | Electric auth secret |
| `ANTHROPIC_API_KEY` | If provided | Claude API key for agents |
| `GH_TOKEN` | If provided | GitHub PAT for git operations |
| `DS_*` (stream vars) | If hosted streams configured | Durable Streams connection (URL, service ID, secret, session ID) |

### Agent Launch

Two launch modes exist depending on the bridge type:

**Stream bridge mode** (default for Sprites):
- `SpritesSandboxProvider.startAgent()` uses `sprite.spawn("bash", [...])` to start the agent without blocking.
- The agent runs `electric-agent headless` and communicates via the stream adapter (Durable Streams).
- Output is redirected to `/tmp/agent-stdout.log` and `/tmp/agent-stderr.log`.
- The server waits 3 seconds after launch for the agent to connect to the stream.

**Stdio bridge mode** (also supported):
- `SpritesStdioBridge.start()` uses `sprite.createSession("bash", [...], { detachable: true })` to get stdin/stdout handles.
- The bridge reads NDJSON from stdout line by line and relays events to the Durable Stream.
- Commands and gate responses are written to the session's stdin.

### Communication Flow

```
React Client ←—SSE—→ Hono Server ←—Durable Stream—→ Agent (in Sprite)
                          ↕                              ↕
                    gate.ts (gates)              headless-adapter.ts
```

**Stream bridge (default):**
1. Both the server and the agent inside the sprite connect to the same hosted Durable Stream.
2. Messages are tagged with `source: "server"` or `source: "agent"`, and each side filters by source.
3. The server writes commands and gate responses to the stream; the agent reads them.
4. The agent writes `EngineEvent`s to the stream; the server reads them for gate resolution.

**Stdio bridge:**
1. The bridge holds a Sprites session with stdin/stdout handles to the agent process.
2. Agent stdout (NDJSON) is parsed line-by-line and appended to the Durable Stream for the UI.
3. Commands and gate responses are written to the agent's stdin.

### Complete Session Flow (Sprites)

```
1. User clicks "Create" in browser
   → POST /api/sessions { description, apiKey, ghToken }

2. Server creates DurableStream + SessionInfo
   → Emits infra_config_prompt gate

3. User selects infrastructure (local/cloud/claim)
   → Gate resolves

4. SpritesSandboxProvider.create():
   a. createSprite("ea-{id}", { ramMB: 2048, cpus: 2, region: "ord" })
   b. setNetworkPolicyAllowAll() — REST API call
   c. ensureBootstrapped() — restore checkpoint or full bootstrap
   d. Write env vars to /etc/profile.d/electric-agent.sh
   e. mkdir /home/agent/workspace/{projectName}
   → Returns SandboxHandle { previewUrl: "https://ea-{id}.sprites.dev" }

5. Server detects Sprites runtime in stream bridge mode:
   → spritesProvider.startAgent(handle)
   → Agent process starts: sources env, runs electric-agent headless
   → Agent connects to Durable Stream via DS_* env vars
   → Server waits 3s for agent to connect

6. Server sends command to stream:
   → { source: "server", type: "command", command: "new", description, ... }

7. Agent reads command from stream, runs orchestrator:
   → clarifier → scaffold → planner → coder → git agent
   → Each phase emits EngineEvents to stream

8. React client receives events via SSE proxy (GET /api/sessions/:id/events)
   → Gates displayed as UI prompts, resolved via POST /api/sessions/:id/respond

9. Agent emits session_complete
   → User sees preview at https://ea-{id}.sprites.dev
```

### SSE Proxy

The React client never connects directly to Durable Streams. Instead, `GET /api/sessions/:id/events` acts as an SSE proxy:

1. Opens a `DurableStream` reader pointed at the session's stream URL (with auth headers).
2. Subscribes with `live: true` for real-time updates.
3. Filters out internal protocol messages (`type: "command"` and `type: "gate_response"`).
4. Strips the `source` field from events before forwarding.
5. Forwards remaining events as SSE `data:` frames with `id:` set to the stream offset.
6. Supports `Last-Event-ID` header for reconnection catch-up.

### Gate Resolution (Sprites)

Gates pause the agent workflow until an external decision arrives. With Sprites:

**Stream bridge mode:**
- Agent calls a gate callback (e.g., `onPlanReady`) → emits gate event to stream → blocks on stream waiting for response
- React client displays gate UI → user responds → `POST /api/sessions/:id/respond`
- Server classifies the gate:
  - **Server-side gates** (`checkpoint`, `publish`, `infra_config`, `repo_setup`): resolved in-process via `resolveGate()`
  - **Container-forwarded gates** (`clarification`, `approval`, `continue`, `revision`): server writes `{ source: "server", type: "gate_response", gate, ... }` to stream → agent picks it up

**Stdio bridge mode:**
- Same flow but gate responses are written to the agent's stdin via `cmd.stdin.write()` instead of to the stream.

### Gotchas & Debugging

- **`sprite.exec()` splits by whitespace**: `exec(command)` does `command.trim().split(/\s+/)`, breaking all shell features (pipes, redirects, `&&`, quoted args). Always use `sprite.execFile("bash", ["-c", "..."])` instead.
- **`createSession()` forces TTY**: Merges stdout/stderr and adds terminal control characters. Avoid for structured output (NDJSON). Use `spawn()` for non-blocking agent launch.
- **PATH issues**: npm global binaries are not in the default PATH. Every command must source `/etc/profile.d/npm-global.sh` first. The env file also sources nvm to make `node`/`npm` available.
- **Checkpoint caching**: The bootstrap checkpoint is per-sprite, not global. Each new sprite either restores from its own checkpoint or bootstraps fresh. If the `electric-agent` package is updated, old checkpoints will have the stale version — destroy and recreate the sprite.
- **Preview URLs**: Sprites expose HTTP at `https://{name}.sprites.dev`. Port 8080 is the default; other ports require the proxy URL format. The dev server runs on port 5173 (set via `VITE_PORT`).
- **Sprite CLI flag order**: The `sprite` CLI uses Go-style flags — flags must come before positional arguments (e.g., `sprite destroy -force ea-abc123`, NOT `sprite destroy ea-abc123 -force`).
- **Network policy**: Must be set immediately after creation or the sprite has no outbound internet access (needed for npm install, Electric sync, etc.).
- **Agent logs**: When using `startAgent()` (stream bridge mode), stdout/stderr are redirected to `/tmp/agent-stdout.log` and `/tmp/agent-stderr.log` inside the sprite. Use `sprite exec <name> -- cat /tmp/agent-stderr.log` to debug.

---

## Key Design Patterns

1. **Callback-driven I/O inversion** — Engine never knows its output target
2. **Dual transport** — NDJSON stdin/stdout for Docker, hosted Durable Stream for cloud sandboxes
3. **Source-tagged bidirectional stream** — Single stream per session, messages tagged `source: "server"` or `source: "agent"`, each side filters by source
4. **SessionBridge abstraction** — Hides transport details; server and sandbox use the same API
5. **Promise-based gates** — Pause workflow until external decision arrives
6. **Durable Streams** — File-backed or hosted event log for replay, catch-up, persistence
7. **Hook interception** — Transparent correctness enforcement without agent awareness
8. **Session resumption** — SDK session IDs preserve full conversation context across runs
9. **Progressive disclosure** — Planner reads playbooks first, coder reads them per-phase as instructed by the plan
10. **Provider-agnostic CRUD** — `SandboxProvider` interface enables Docker/Daytona/Sprites swap without changing server code
11. **Checkpoint-accelerated bootstrap** — Sprites install tooling once, checkpoint the VM state, and restore instantly on subsequent creates
