# Web UI Design

## Overview

A standalone web UI for `electric-agent` that mirrors the CLI experience in a browser: a prompt window, a streaming console, and clickable/collapsible tool executions with full logs. The entire conversation history is persisted and streamed in real-time via **durable-streams**.

The CLI continues to work exactly as-is. The refactoring extracts shared orchestration logic into an **engine layer** that both CLI and web UI consume through different I/O adapters.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser (SPA)                        │
│                                                             │
│  ┌─────────────┐  ┌──────────────────────────────────────┐  │
│  │ Prompt Input │  │          Console Output              │  │
│  │             │  │  ┌──────────────────────────────────┐ │  │
│  │  [textarea] │  │  │ [plan] Analyzing description...  │ │  │
│  │  [send btn] │  │  │ [task] Scaffolding project...    │ │  │
│  │             │  │  │ ▶ Write: src/db/schema.ts ───────│─│──── clickable
│  │             │  │  │   └─ (collapsed: full diff)      │ │  │
│  │             │  │  │ ▶ Bash: pnpm run build ──────────│─│──── clickable
│  │             │  │  │   └─ (collapsed: full output)    │ │  │
│  │             │  │  │ [build] Build passed              │ │  │
│  │             │  │  │ [done] Agent completed ($0.42)    │ │  │
│  │             │  │  └──────────────────────────────────┘ │  │
│  └─────────────┘  └──────────────────────────────────────┘  │
└──────────────┬──────────────────────────────┬───────────────┘
               │ POST /api/...                │ GET /v1/stream/{sessionId}
               │ (commands)                   │ (SSE live tail)
               ▼                              ▼
┌──────────────────────────┐   ┌──────────────────────────────┐
│     Web API Server       │   │    Durable Streams Server    │
│     (Hono on Node)       │   │    (@durable-streams/server) │
│                          │   │                              │
│  POST /api/session/new   │   │  Stream per session:         │
│  POST /api/session/:id/  │   │    /session/{id}             │
│        iterate           │   │                              │
│  POST /api/session/:id/  │   │  Append: engine events       │
│        approve           │   │  Read: browser SSE           │
│  POST /api/session/:id/  │   │  Persist: file-backed store  │
│        continue          │   │                              │
│  GET  /api/session/:id/  │   │  Port: 4437                  │
│        status            │   │                              │
│  POST /api/session/:id/  │───│  Created per session by      │
│        cancel            │   │  the web API server          │
│                          │   │                              │
│  Port: 4400              │   └──────────────────────────────┘
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│      Engine Layer        │
│   (shared orchestration) │
│                          │
│  engine/session.ts       │ ← session lifecycle
│  engine/orchestrator.ts  │ ← runs planner/coder, emits events
│  engine/events.ts        │ ← event type definitions
│                          │
│  Consumes:               │
│    agents/*              │
│    tools/*               │
│    hooks/*               │
│    scaffold/*            │
│    working-memory/*      │
└──────────────────────────┘
```

---

## Layer 1: Engine (shared core)

The engine is the refactored orchestration logic that both CLI and web UI call. It replaces the direct coupling between CLI commands and agent execution.

### `src/engine/events.ts` — Event Types

Every action the engine takes emits a typed event. These events are the single source of truth for both the CLI reporter and the durable stream.

```typescript
type EngineEvent =
  // Progress events (map to existing LogLevels)
  | { type: "log"; level: LogLevel; message: string; ts: string }
  | { type: "tool_start"; toolName: string; toolUseId: string; input: Record<string, unknown>; ts: string }
  | { type: "tool_result"; toolUseId: string; output: string; ts: string }

  // Agent text output
  | { type: "assistant_text"; text: string; ts: string }
  | { type: "assistant_thinking"; text: string; ts: string }

  // Phase gates (require user input)
  | { type: "clarification_needed"; questions: string[]; confidence: number; summary: string }
  | { type: "plan_ready"; plan: string }
  | { type: "continue_needed"; reason: "max_turns" | "max_budget" }

  // Terminal events
  | { type: "phase_complete"; phase: string; success: boolean; errors: string[] }
  | { type: "session_complete"; success: boolean }
```

### `src/engine/orchestrator.ts` — Orchestrator

The orchestrator runs the same logic as `cli/new.ts` and `cli/iterate.ts`, but instead of doing readline I/O directly, it:
1. **Emits events** via a callback `(event: EngineEvent) => void`
2. **Awaits user decisions** via async callbacks that the caller provides

```typescript
interface OrchestratorCallbacks {
  onEvent: (event: EngineEvent) => void | Promise<void>

  // Gates — the orchestrator pauses until these resolve
  onClarificationNeeded: (questions: string[], summary: string) => Promise<string[]>  // answers
  onPlanReady: (plan: string) => Promise<"approve" | "revise" | "cancel">
  onRevisionRequested: () => Promise<string>  // revision feedback
  onContinueNeeded: () => Promise<boolean>
}

// For `electric-agent new`
async function runNew(opts: {
  description: string
  projectName?: string
  debug?: boolean
  autoApprove?: boolean
  callbacks: OrchestratorCallbacks
}): Promise<void>

// For `electric-agent iterate`
async function runIterate(opts: {
  projectDir: string
  userRequest: string
  debug?: boolean
  callbacks: OrchestratorCallbacks
}): Promise<void>
```

### How the CLI adapts

The existing CLI commands become thin wrappers:

```typescript
// cli/new.ts (after refactoring)
export async function newCommand(opts) {
  const reporter = createProgressReporter({ debug: opts.debug })

  const description = await promptDescription()   // unchanged readline

  await runNew({
    description,
    projectName: opts.name,
    debug: opts.debug,
    autoApprove: opts.approve === false,
    callbacks: {
      onEvent(event) {
        // Route events to the existing console reporter
        cliEventHandler(event, reporter)
      },
      async onClarificationNeeded(questions, summary) {
        // Same readline prompting as before
        return promptClarificationAnswers(questions)
      },
      async onPlanReady(plan) {
        console.log(`\n${plan}\n`)
        return promptApproval()
      },
      async onRevisionRequested() {
        return promptRevision()
      },
      async onContinueNeeded() {
        return promptContinue()
      },
    },
  })
}
```

The `cliEventHandler` maps engine events back to the existing `ProgressReporter` calls — so CLI output is byte-for-byte identical.

### How the agent streaming connects

Inside the orchestrator, the existing `for await (const message of query(...))` loop is preserved. Each SDK message is:
1. Parsed into one or more `EngineEvent`s
2. Emitted via `callbacks.onEvent()`
3. The existing `processAgentMessage` logic is reused inside the event parser

This means the `runCoder` and `runPlanner` functions are modified to accept an `onEvent` callback instead of a `ProgressReporter`. A small adapter creates a `ProgressReporter` from the callback for backward compatibility during the transition.

---

## Layer 2: Durable Streams Integration

### Stream-per-session model

Each agent session (one `new` or `iterate` run) maps to one durable stream:

```
/session/{sessionId}          ← all events for this session
```

The `sessionId` is a UUID generated when the user starts a new project or iteration.

### Server setup

The durable-streams server runs as part of the `electric-agent` infrastructure, started alongside the web API server:

```typescript
// src/web/infra.ts
import { DurableStreamTestServer, FileBackedStreamStore } from "@durable-streams/server"

export async function startStreamServer(dataDir: string) {
  const store = new FileBackedStreamStore({ path: dataDir })
  const server = new DurableStreamTestServer({
    port: 4437,
    host: "127.0.0.1",
    store,
  })
  await server.start()
  return server
}
```

### Event flow: Engine → Durable Stream → Browser

```
Engine orchestrator
    │
    │  onEvent(event)
    ▼
Web API handler
    │
    │  producer.append(event)
    ▼
Durable Streams Server (port 4437)
    │
    │  SSE / long-poll
    ▼
Browser client
    │
    │  res.subscribeJson(batch => ...)
    ▼
React state update → UI render
```

The web API handler creates an `IdempotentProducer` per session and appends every `EngineEvent` as a JSON message. The browser subscribes to the same stream path and receives events in order, with automatic catch-up if the page is refreshed or the connection drops.

### Conversation history / replay

Since every event is persisted in the durable stream (file-backed), the full conversation history is available by reading from offset `"-1"`. When a user returns to a session:

1. Browser reads the stream from the beginning
2. Replays all events to reconstruct the UI state
3. Seamlessly transitions to live mode for new events

No separate database needed — durable-streams **is** the persistence layer for session history.

### Stream lifecycle

```
POST /api/session/new
  → Create stream: /session/{id}
  → Start engine orchestrator
  → Append events as they happen

POST /api/session/:id/iterate
  → Reuse existing stream (append to same log)
  → New events have incrementing offsets

GET /v1/stream/session/{id}?offset=-1&live=sse
  → Browser reads full history + live tail
```

Multiple iterations on the same project append to the same stream, giving a complete chronological log of everything that happened.

---

## Layer 3: Web API Server

A lightweight HTTP server using **Hono** (fast, small, TypeScript-native).

### Endpoints

```
POST   /api/sessions                     → Start new project
  Body: { description: string, name?: string }
  Returns: { sessionId: string }
  Side effect: starts orchestrator, creates stream

POST   /api/sessions/:id/iterate         → Send iteration request
  Body: { request: string }
  Returns: { ok: true }

POST   /api/sessions/:id/respond         → Answer a gate (clarification, approval, continue)
  Body: { gate: "clarification", answers: string[] }
      | { gate: "approval", decision: "approve"|"revise"|"cancel" }
      | { gate: "revision", feedback: string }
      | { gate: "continue", proceed: boolean }
  Returns: { ok: true }

GET    /api/sessions/:id/status          → Current session state
  Returns: SessionState (from working-memory)

POST   /api/sessions/:id/cancel          → Cancel running agent
  Returns: { ok: true }

GET    /api/sessions                     → List all sessions
  Returns: { sessions: SessionSummary[] }

POST   /api/infra/up                     → docker compose up + migrations
POST   /api/infra/down                   → docker compose down
```

### Gate mechanism

When the orchestrator hits a gate (e.g., `onPlanReady`), it:
1. Appends a gate event to the stream (so the UI knows to show a prompt)
2. Returns a `Promise` that blocks the orchestrator
3. The web API stores a resolver for this promise keyed by `sessionId`
4. When the user POSTs to `/api/sessions/:id/respond`, the resolver is called
5. The orchestrator resumes

```typescript
// Simplified gate handling
const gates = new Map<string, { resolve: (value: unknown) => void }>()

// In orchestrator callbacks:
async onPlanReady(plan) {
  onEvent({ type: "plan_ready", plan })
  return new Promise(resolve => {
    gates.set(`${sessionId}:approval`, { resolve })
  })
}

// In API handler:
app.post("/api/sessions/:id/respond", async (c) => {
  const { gate, ...data } = await c.req.json()
  const key = `${c.req.param("id")}:${gate}`
  const pending = gates.get(key)
  if (pending) {
    pending.resolve(data)
    gates.delete(key)
  }
  return c.json({ ok: true })
})
```

### Running the server

New CLI command:

```
electric-agent serve [--port 4400] [--data-dir .electric-agent]
```

This starts:
1. Durable streams server on port 4437
2. Web API + static file server on port 4400

---

## Layer 4: Frontend (React SPA)

### Tech stack

- **React 19** — UI framework
- **Vite** — build tool
- **@durable-streams/client** — stream subscription
- **Tailwind CSS** — styling (already familiar from TanStack ecosystem)
- No routing library needed (single-page app with a single view)

### Directory structure

```
src/web/
├── server.ts                 # Hono web API server
├── infra.ts                  # Durable streams server startup
├── gate.ts                   # Gate/promise management for user decisions
├── cli-adapter.ts            # Maps EngineEvents → ProgressReporter for CLI
└── client/                   # React SPA (built separately with Vite)
    ├── index.html
    ├── main.tsx
    ├── App.tsx               # Top-level layout
    ├── hooks/
    │   └── useSession.ts     # Stream subscription + event reducer
    ├── components/
    │   ├── PromptInput.tsx    # Text input + send button
    │   ├── Console.tsx        # Scrolling event log
    │   ├── ConsoleEntry.tsx   # Single log line (level-colored)
    │   ├── ToolExecution.tsx  # Clickable/collapsible tool block
    │   ├── GatePrompt.tsx     # Approval/clarification/continue UI
    │   └── SessionList.tsx    # Session selector sidebar
    ├── lib/
    │   └── api.ts            # fetch wrappers for /api/*
    └── styles/
        └── index.css         # Tailwind + console color tokens
```

### Key component: `useSession` hook

This hook is the core data layer. It subscribes to a durable stream and reduces events into UI state.

```typescript
function useSession(sessionId: string) {
  const [entries, setEntries] = useState<ConsoleEntry[]>([])
  const [pendingGate, setPendingGate] = useState<GateEvent | null>(null)
  const [phase, setPhase] = useState<string>("idle")
  const offsetRef = useRef<string>("-1")

  useEffect(() => {
    const res = await stream<EngineEvent>({
      url: `http://localhost:4437/v1/stream/session/${sessionId}`,
      offset: offsetRef.current,
      live: true,
    })

    res.subscribeJson(async (batch) => {
      for (const event of batch.items) {
        // Reduce event into UI state
        switch (event.type) {
          case "log":
            appendEntry({ kind: "log", level: event.level, message: event.message })
            break
          case "tool_start":
            appendEntry({
              kind: "tool",
              toolName: event.toolName,
              toolUseId: event.toolUseId,
              input: event.input,
              output: null,  // filled in when tool_result arrives
              collapsed: true,
            })
            break
          case "tool_result":
            updateToolEntry(event.toolUseId, { output: event.output })
            break
          case "plan_ready":
          case "clarification_needed":
          case "continue_needed":
            setPendingGate(event)
            break
          case "phase_complete":
          case "session_complete":
            setPhase(event.type)
            break
        }
      }
      offsetRef.current = batch.offset
      // Persist offset to localStorage for resumability
      localStorage.setItem(`offset:${sessionId}`, batch.offset)
    })
  }, [sessionId])

  return { entries, pendingGate, phase }
}
```

### Console entry types

```typescript
type ConsoleEntry =
  | { kind: "log"; level: LogLevel; message: string }
  | { kind: "tool"; toolName: string; toolUseId: string;
      input: Record<string, unknown>; output: string | null;
      collapsed: boolean }
  | { kind: "text"; text: string }  // assistant text blocks
```

### Tool execution component (clickable + collapsible)

```
┌──────────────────────────────────────────────┐
│ ▶ Write  src/db/schema.ts                    │  ← collapsed (default)
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ ▼ Write  src/db/schema.ts                    │  ← expanded on click
│ ┌──────────────────────────────────────────┐ │
│ │ Input:                                   │ │
│ │   file_path: src/db/schema.ts            │ │
│ │   content: (352 lines)                   │ │
│ │ ┌──────────────────────────────────────┐ │ │
│ │ │ import { pgTable, uuid, text } ...   │ │ │
│ │ │ ...                                  │ │ │
│ │ └──────────────────────────────────────┘ │ │
│ │                                          │ │
│ │ Result: ✓ File written                   │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ ▼ Bash  pnpm run build                       │  ← expanded
│ ┌──────────────────────────────────────────┐ │
│ │ $ pnpm run build                         │ │
│ │                                          │ │
│ │ > tsc --noEmit                           │ │
│ │ > vite build                             │ │
│ │ ✓ built in 3.2s                          │ │
│ │                                          │ │
│ │ Result: exit code 0                      │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

Each tool execution is a `<details>` element (or equivalent) with:
- **Summary line**: tool icon + name + brief description (file path / command)
- **Expanded body**: full input parameters + full output (scrollable, monospace)
- Tool executions that are in-progress show a spinner
- Failed tools show a red indicator

### Gate prompts

When the orchestrator hits a gate, the UI shows an inline prompt:

**Clarification gate:**
```
┌──────────────────────────────────────────────┐
│ Confidence: 45% — need more details          │
│                                              │
│ 1. What entities should the app track?       │
│    [text input                          ]    │
│                                              │
│ 2. Should it support user authentication?    │
│    [text input                          ]    │
│                                              │
│              [Submit Answers]                 │
└──────────────────────────────────────────────┘
```

**Plan approval gate:**
```
┌──────────────────────────────────────────────┐
│ ▼ Plan (click to expand)                     │
│ ┌──────────────────────────────────────────┐ │
│ │ # Implementation Plan                    │ │
│ │ ## Phase 1: Schema                       │ │
│ │ - [ ] Create users table                 │ │
│ │ - [ ] Create posts table                 │ │
│ │ ...                                      │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│  [Approve]  [Revise]  [Cancel]               │
└──────────────────────────────────────────────┘
```

**Continue gate:**
```
┌──────────────────────────────────────────────┐
│ Agent reached turn limit. Continue?          │
│                                              │
│  [Continue]  [Stop]                          │
└──────────────────────────────────────────────┘
```

---

## Refactoring Plan (CLI preserved)

The refactoring is designed so the CLI works identically after the change. Here's the migration path:

### Step 1: Create `src/engine/events.ts`
Define the `EngineEvent` union type. No existing code changes.

### Step 2: Create `src/engine/orchestrator.ts`
Extract the orchestration logic from `cli/new.ts` and `cli/iterate.ts` into callback-driven functions (`runNew`, `runIterate`). The core agent-calling code (`runCoder`, `runPlanner`) stays in `src/agents/` — the orchestrator just calls them.

### Step 3: Modify `agents/coder.ts` and `agents/planner.ts`
Add an optional `onMessage` callback parameter alongside the existing `reporter` parameter. When provided, the raw SDK message is forwarded to the callback in addition to being processed by the reporter. This is additive — the reporter continues to work for CLI use.

```typescript
export async function runCoder(
  projectDir: string,
  task?: string,
  reporter?: ProgressReporter,
  onMessage?: (msg: Record<string, unknown>) => void,  // new, optional
): Promise<CoderResult>
```

### Step 4: Create `src/engine/cli-adapter.ts`
A thin adapter that implements `OrchestratorCallbacks` using readline (the existing CLI prompting functions). This replaces the inline readline code in `cli/new.ts` and `cli/iterate.ts`.

### Step 5: Slim down `cli/new.ts` and `cli/iterate.ts`
Replace the orchestration logic with calls to the engine:

```typescript
// cli/new.ts becomes ~20 lines
import { runNew } from "../engine/orchestrator.js"
import { createCliCallbacks } from "../engine/cli-adapter.js"

export async function newCommand(opts) {
  const description = await promptDescription()
  await runNew({
    description,
    projectName: opts.name,
    callbacks: createCliCallbacks({ debug: opts.debug }),
  })
}
```

### Step 6: Build the web layer (`src/web/`)
Implements `OrchestratorCallbacks` that:
- Appends events to durable streams instead of console.log
- Resolves gates via HTTP POST instead of readline

### Step 7: Build the React client (`src/web/client/`)
Subscribes to durable streams and renders the console UI.

### What stays the same
- `agents/planner.ts` — same Opus agent, same prompt
- `agents/coder.ts` — same Sonnet agent, same prompt, same hooks
- `agents/clarifier.ts` — unchanged
- `tools/*` — unchanged
- `hooks/*` — unchanged
- `scaffold/*` — unchanged
- `working-memory/*` — unchanged
- `progress/reporter.ts` — unchanged (CLI adapter uses it directly)

---

## Infrastructure

### `docker-compose.yml` addition

The durable-streams server is added to the existing docker-compose as an optional service (for production). During development, the `electric-agent serve` command starts it in-process.

```yaml
services:
  # ... existing postgres, electric, caddy ...

  streams:
    image: node:20-slim
    working_dir: /app
    command: ["node", "dist/web/stream-server.js"]
    ports:
      - "4437:4437"
    volumes:
      - streams-data:/app/data

volumes:
  streams-data:
```

For development, the durable-streams server runs in-process within the `electric-agent serve` command — no Docker needed.

### New dependencies

```json
{
  "dependencies": {
    "@durable-streams/server": "latest",
    "@durable-streams/client": "latest",
    "hono": "^4",
    "@hono/node-server": "^1"
  },
  "devDependencies": {
    "react": "^19",
    "react-dom": "^19",
    "@vitejs/plugin-react": "^4",
    "tailwindcss": "^4"
  }
}
```

### Build setup

The project gets a second Vite config for the client SPA:

```
src/web/client/vite.config.ts   → builds to dist/web/client/
src/web/server.ts               → compiled by tsc to dist/web/server.js
```

The `npm run build` script is extended to build both the CLI (tsc) and the web client (vite build).

---

## New CLI command

```
electric-agent serve [options]

Options:
  --port <number>       Web server port (default: 4400)
  --streams-port <n>    Durable streams port (default: 4437)
  --data-dir <path>     Data directory for stream persistence (default: .electric-agent)
  --open                Open browser on start

Starts the web UI server. This runs:
  1. Durable streams server (file-backed persistence)
  2. Web API server (Hono)
  3. Static file server for the React SPA
```

---

## Data Model: Stream Events

Each durable stream stores a flat sequence of `EngineEvent` JSON objects. The stream path is `/session/{sessionId}`.

Example stream contents:

```jsonl
{"type":"log","level":"plan","message":"Analyzing your description...","ts":"2025-01-15T10:00:01Z"}
{"type":"log","level":"plan","message":"Confidence: 85% — description is clear","ts":"2025-01-15T10:00:03Z"}
{"type":"log","level":"task","message":"Scaffolding project from KPB template...","ts":"2025-01-15T10:00:04Z"}
{"type":"tool_start","toolName":"Bash","toolUseId":"tu_1","input":{"command":"npx gitpick ..."},"ts":"2025-01-15T10:00:05Z"}
{"type":"tool_result","toolUseId":"tu_1","output":"Cloned successfully","ts":"2025-01-15T10:00:12Z"}
{"type":"log","level":"done","message":"Scaffold complete","ts":"2025-01-15T10:00:13Z"}
{"type":"log","level":"plan","message":"Running planner agent...","ts":"2025-01-15T10:00:14Z"}
{"type":"plan_ready","plan":"# Implementation Plan\n\n## Phase 1: Schema\n...","ts":"2025-01-15T10:01:30Z"}
{"type":"log","level":"task","message":"Running coder agent...","ts":"2025-01-15T10:02:00Z"}
{"type":"tool_start","toolName":"Write","toolUseId":"tu_2","input":{"file_path":"src/db/schema.ts","content":"..."},"ts":"2025-01-15T10:02:05Z"}
{"type":"tool_result","toolUseId":"tu_2","output":"File written","ts":"2025-01-15T10:02:06Z"}
{"type":"tool_start","toolName":"Bash","toolUseId":"tu_3","input":{"command":"pnpm run build"},"ts":"2025-01-15T10:02:10Z"}
{"type":"tool_result","toolUseId":"tu_3","output":"Build passed\n...","ts":"2025-01-15T10:02:18Z"}
{"type":"log","level":"build","message":"Build passed","ts":"2025-01-15T10:02:18Z"}
{"type":"phase_complete","phase":"generation","success":true,"errors":[],"ts":"2025-01-15T10:05:00Z"}
{"type":"session_complete","success":true,"ts":"2025-01-15T10:05:00Z"}
```

The browser reconstructs the full UI from this event log. Tool entries are matched by `toolUseId` — a `tool_start` creates the entry, a `tool_result` fills in the output.

---

## Session Management

Sessions are tracked in a local JSON index file at `{dataDir}/sessions.json`:

```json
{
  "sessions": [
    {
      "id": "abc-123",
      "projectName": "my-todo-app",
      "projectDir": "/home/user/my-todo-app",
      "description": "A collaborative todo app with real-time sync",
      "createdAt": "2025-01-15T10:00:00Z",
      "lastActiveAt": "2025-01-15T10:05:00Z",
      "status": "complete"
    }
  ]
}
```

This is a lightweight index for the session list sidebar. The actual event data lives in the durable streams.

---

## Summary

| Concern | Solution |
|---------|----------|
| Real-time streaming | Durable streams SSE subscription |
| Conversation persistence | Durable streams file-backed store |
| Session resumability | Offset-based catch-up from `-1` |
| CLI compatibility | Engine layer with callback adapters |
| Clickable tool logs | `tool_start`/`tool_result` event pairs matched by `toolUseId` |
| Approval gates | Gate events in stream + HTTP POST resolution |
| Infrastructure | In-process durable-streams server started by `electric-agent serve` |
| Frontend | React SPA with stream subscription hook |
