# Web UI Design — create-electric-app

## Overview

Add a browser-based interface to `electric-agent` as a complement to the CLI. Launch via `electric-agent ui`. The web UI provides the same workflow — describe → clarify → scaffold → plan → approve → generate → iterate — with real-time streaming of every agent action (file writes, builds, playbook reads, cost).

**Key principle:** The web server is a thin HTTP layer calling the same core functions as the CLI. No business logic is duplicated. The existing `ProgressReporter` interface is extended to push events over SSE.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (React)                     │
│  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌─────────────┐  │
│  │  Describe │ │  Review  │ │Generate│ │   Iterate   │  │
│  │   +Q&A   │ │   Plan   │ │Progress│ │    Chat     │  │
│  └──────────┘ └──────────┘ └────────┘ └─────────────┘  │
└───────────────────────┬─────────────────────────────────┘
                        │ HTTP + SSE
┌───────────────────────┴─────────────────────────────────┐
│               Web Server (src/server/)                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ REST API │ │SSE Stream│ │ Session  │ │  Static   │  │
│  │ Routes   │ │ Endpoint │ │  Store   │ │  Serving  │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
└───────────────────────┬─────────────────────────────────┘
                        │ Direct function calls
┌───────────────────────┴─────────────────────────────────┐
│                 Existing Core (unchanged)                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ Clarifier│ │ Planner  │ │  Coder   │ │ Scaffold  │  │
│  │  Agent   │ │  Agent   │ │  Agent   │ │           │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                │
│  │  Hooks   │ │MCP Tools │ │ Working  │                │
│  │          │ │          │ │  Memory  │                │
│  └──────────┘ └──────────┘ └──────────┘                │
└─────────────────────────────────────────────────────────┘
```

---

## Technology Choices

| Layer      | Choice          | Rationale                                                  |
|------------|-----------------|-----------------------------------------------------------|
| Frontend   | React + Vite    | Lightweight, fast HMR, team knows React from templates     |
| Styling    | Tailwind CSS v4  | Utility-first, no component library needed, fast to build  |
| Backend    | Node `http` server | Zero new deps — `node:http` is sufficient for REST + SSE |
| Streaming  | SSE (Server-Sent Events) | Simpler than WebSocket, unidirectional server→client, native `EventSource` API, automatic reconnection |
| Markdown   | react-markdown  | Render PLAN.md with syntax highlighting in the browser     |
| State      | React context + useReducer | Simple, no external state library needed      |
| Routing    | Hash-based (custom) | ~30 lines, avoids a dependency for 6 routes            |

**New dependencies (production):**
- `react`, `react-dom`
- `react-markdown`, `react-syntax-highlighter`

**New dependencies (dev):**
- `vite`, `@vitejs/plugin-react`
- `tailwindcss`, `@tailwindcss/vite`

---

## New CLI Command

```
electric-agent ui [--port 3456] [--debug]
```

- Starts the Node HTTP server on the given port (default: 3456)
- Serves the built React SPA at `/` (from `dist/web/`)
- Exposes API routes at `/api/*`
- Opens the browser automatically (or prints the URL)

Added to `src/index.ts`:
```typescript
program
  .command("ui")
  .description("Launch web interface")
  .option("-p, --port <port>", "Port number", "3456")
  .option("--debug", "Enable debug mode")
  .action(uiCommand)
```

---

## File Structure

```
src/
├── server/                         # NEW — Web server layer
│   ├── index.ts                    # HTTP server, route dispatch, static file serving
│   ├── routes/                     # API route handlers
│   │   ├── projects.ts             # CRUD for projects (scaffold, list, status)
│   │   ├── clarify.ts              # POST /api/clarify — run clarifier agent
│   │   ├── plan.ts                 # POST /api/plan — run planner (SSE)
│   │   ├── generate.ts             # POST /api/generate — run coder (SSE)
│   │   ├── iterate.ts              # POST /api/iterate — run coder iteration (SSE)
│   │   └── infra.ts                # POST /api/up, /api/down — Docker lifecycle
│   ├── sse.ts                      # SSE connection manager + event helpers
│   └── web-reporter.ts             # ProgressReporter → SSE event bridge
├── cli/
│   └── ui.ts                       # NEW — `electric-agent ui` command
web/                                # NEW — React frontend (built by Vite → dist/web/)
├── index.html                      # SPA entry point
├── vite.config.ts                  # Vite config (proxy /api → server in dev)
├── src/
│   ├── main.tsx                    # React mount point
│   ├── App.tsx                     # Router + top-level layout
│   ├── api.ts                      # Fetch helpers + SSE hook
│   ├── state.ts                    # useReducer state + context provider
│   ├── pages/
│   │   ├── Home.tsx                # Description input + recent projects
│   │   ├── Clarify.tsx             # Clarification Q&A (conditional)
│   │   ├── Plan.tsx                # Plan review + approve/revise
│   │   ├── Generate.tsx            # Live generation progress
│   │   ├── Dashboard.tsx           # Project status + actions
│   │   └── Iterate.tsx             # Chat-style iteration interface
│   └── components/
│       ├── Layout.tsx              # App shell (header + content)
│       ├── MarkdownViewer.tsx      # Render PLAN.md with code highlighting
│       ├── ProgressLog.tsx         # Auto-scrolling streaming activity log
│       ├── TaskList.tsx            # Task checklist from PLAN.md
│       ├── BuildBadge.tsx          # Build pass/fail indicator
│       └── ChatInput.tsx           # Text input for iterate mode
```

---

## Screen Designs

### Screen 1: Home (`/`)

```
┌─────────────────────────────────────────────────────────┐
│  Electric Agent                                 [Debug] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│          Describe your application                      │
│  ┌───────────────────────────────────────────────────┐  │
│  │                                                   │  │
│  │  A collaborative todo app where teams can         │  │
│  │  create projects, assign tasks, and track         │  │
│  │  progress in real-time...                         │  │
│  │                                                   │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  Project name (optional): ___________________________   │
│                                                         │
│                                   [ Create Project → ]  │
│                                                         │
│  ── Recent Projects ──────────────────────────────────  │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ team-tasks      ████████░░ 80%   Build: passing   │  │
│  │ recipe-book     ██████████ 100%  Build: passing   │  │
│  │ budget-tracker  ████░░░░░░ 40%   Build: failing   │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

- Multi-line textarea for app description
- Optional project name (auto-generated via kebab-case if blank)
- Recent projects list: scans for directories with `PLAN.md` + `_agent/session.md`
- Click a project → Dashboard

### Screen 2: Clarification (`/clarify`)

Shown only when clarifier returns confidence < 70%.

```
┌─────────────────────────────────────────────────────────┐
│  Electric Agent  ›  New Project                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Confidence: 55% — need a few more details              │
│  Understanding: "A task management app for teams"       │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ 1. What are the main entities beyond tasks?       │  │
│  │    ___________________________________________    │  │
│  │                                                   │  │
│  │ 2. Should tasks have due dates and priorities?    │  │
│  │    ___________________________________________    │  │
│  │                                                   │  │
│  │ 3. How should team members be organized?          │  │
│  │    ___________________________________________    │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  [ Back ]                              [ Continue → ]   │
└─────────────────────────────────────────────────────────┘
```

- Displays confidence score + one-sentence summary
- Clarification questions with text inputs
- Answers appended to description before planning

### Screen 3: Plan Review (`/plan`)

```
┌─────────────────────────────────────────────────────────┐
│  Electric Agent  ›  team-tasks  ›  Plan                 │
├─────────────────────────────────────────────────────────┤
│  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐  │
│  │   Generating plan...  ◐  Reading playbooks       │  │
│  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘  │
│                  ↓ replaced when done                   │
│  ┌───────────────────────────────────────────────────┐  │
│  │ # Implementation Plan                             │  │
│  │                                                   │  │
│  │ ## App Description                                │  │
│  │ A collaborative todo app where teams can...       │  │
│  │                                                   │  │
│  │ ## Data Model                                     │  │
│  │ ```typescript                                     │  │
│  │ export const projects = pgTable("projects", {     │  │
│  │   id: uuid().primaryKey().defaultRandom(),        │  │
│  │   ...                                             │  │
│  │ ```                                               │  │
│  │                                                   │  │
│  │ ## Phase 1: Data Model & Migrations               │  │
│  │ - [ ] Create Drizzle schema                       │  │
│  │ - [ ] Generate migration                          │  │
│  │ ...                                               │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  Revision notes (optional):                             │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Add a comments feature to tasks                   │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  [ Cancel ]          [ Revise Plan ]     [ Approve → ]  │
└─────────────────────────────────────────────────────────┘
```

- Loading state with spinner while planner runs (SSE for progress)
- Rendered PLAN.md as formatted markdown with syntax-highlighted code blocks
- Three actions: Cancel, Revise (re-run planner with feedback), Approve
- Optional text area for revision feedback

### Screen 4: Generation Progress (`/generate`)

```
┌─────────────────────────────────────────────────────────┐
│  Electric Agent  ›  team-tasks  ›  Generating           │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Phase 2 of 5: Collections & API Routes                 │
│  ██████████████░░░░░░░░░░░░░░░░  12/27 tasks  44%      │
│                                                         │
│  ┌─ Tasks ────────────────────────────────────────────┐ │
│  │ ✓ Create Drizzle schema for projects table         │ │
│  │ ✓ Create Drizzle schema for tasks table            │ │
│  │ ✓ Generate SQL migration                           │ │
│  │ ✓ Run drizzle-kit migrate                          │ │
│  │ ✓ Derive Zod schemas from Drizzle tables           │ │
│  │ ● Define projects collection with Electric...      │ │
│  │ ○ Define tasks collection                          │ │
│  │ ○ Create shape proxy route for projects            │ │
│  │ ○ Create shape proxy route for tasks               │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  ┌─ Activity ─────────────────────────────────────────┐ │
│  │ 14:23:01  [task]  Defining projects collection     │ │
│  │ 14:23:02    ↳ Playbook: collections                │ │
│  │ 14:23:05    ↳ Write: src/collections/projects.ts   │ │
│  │ 14:23:06    ↳ Write: src/collections/tasks.ts      │ │
│  │ 14:23:08  [build] Running build...                 │ │
│  │ 14:23:15  [build] Build passed                     │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  Build: ✓ passing    Cost: $1.24    Errors: 0           │
│                                                         │
│  [ Stop ]                                               │
└─────────────────────────────────────────────────────────┘
```

- Progress bar with current phase and task count (parsed from PLAN.md `[x]`/`[ ]`)
- Task list: ✓ done, ● in-progress, ○ pending
- Auto-scrolling activity log streamed via SSE
- Footer: build status, running cost, error count
- "Stop" button for graceful halt
- On `max_turns`: inline "Continue" / "Stop" prompt

### Screen 5: Dashboard (`/project/:name`)

```
┌─────────────────────────────────────────────────────────┐
│  Electric Agent  ›  team-tasks                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─ Status ───────────────────────────────────────────┐ │
│  │ Phase: complete   Build: ✓ passing   Errors: 2     │ │
│  │ ██████████████████████████████  27/27 tasks  100%  │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  ┌─ Actions ──────────────────────────────────────────┐ │
│  │ [ Start Services ]  [ Stop Services ]              │ │
│  │ [ Open App → localhost:5173 ]                      │ │
│  │ [ Iterate → ]                                      │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  ┌─ Plan ─────────────────────────────────────────────┐ │
│  │ [Rendered PLAN.md — collapsed by default]          │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  ┌─ Errors ───────────────────────────────────────────┐ │
│  │ #1 [build] src/db/schema.ts — Missing comma        │ │
│  │    Fix: Added comma after column  ✓ resolved       │ │
│  │ #2 [build] src/routes/api.ts — Wrong import        │ │
│  │    Fix: Changed to drizzle-zod   ✓ resolved        │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

- Status bar: phase, build status, error count, progress
- Actions: start/stop Docker services, open generated app, go to iterate
- Collapsible rendered PLAN.md
- Error log from `_agent/errors.md`

### Screen 6: Iterate (`/iterate/:name`)

```
┌─────────────────────────────────────────────────────────┐
│  Electric Agent  ›  team-tasks  ›  Iterate              │
├──────────────────────────┬──────────────────────────────┤
│                          │                              │
│  Conversation            │  Activity                    │
│                          │                              │
│  ┌────────────────────┐  │  [task] Reading PLAN.md      │
│  │ You:               │  │    ↳ Read: PLAN.md           │
│  │ Add a comments     │  │    ↳ Playbook: mutations     │
│  │ feature to tasks   │  │  [task] Adding comments      │
│  └────────────────────┘  │    ↳ Write: src/db/schema.ts │
│                          │    ↳ Bash: drizzle-kit gen    │
│  ┌────────────────────┐  │    ↳ Bash: drizzle-kit mig   │
│  │ Agent:             │  │    ↳ Write: collections/     │
│  │ I'll add a         │  │      comments.ts             │
│  │ comments table     │  │    ↳ Write: routes/api/      │
│  │ related to tasks   │  │      comments.ts             │
│  │ with text content  │  │  [build] Running build...    │
│  │ and timestamps...  │  │  [build] Build passed ✓      │
│  └────────────────────┘  │  [done] Changes applied      │
│                          │                              │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Describe your change...                     [→]  │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

- Split layout: conversation (left), activity log (right)
- Chat-style messages for user requests + agent text responses
- Activity feed with real-time tool use (file writes, builds, playbook reads)
- Input at the bottom for next iteration request

---

## API Design

### REST Endpoints

| Method | Path | Body | Response | Action |
|--------|------|------|----------|--------|
| `GET`  | `/api/projects` | — | `Project[]` | List projects (scan for PLAN.md dirs) |
| `POST` | `/api/projects` | `{ description, name? }` | `{ id, dir }` | Scaffold new project |
| `POST` | `/api/projects/:id/clarify` | `{ description }` | `{ confidence, summary, questions }` | Run clarifier |
| `POST` | `/api/projects/:id/plan` | `{ description }` | `202 { streamId }` | Start planner → SSE |
| `POST` | `/api/projects/:id/plan/revise` | `{ description, feedback }` | `202 { streamId }` | Re-run planner |
| `POST` | `/api/projects/:id/approve` | `{ plan }` | `200` | Write PLAN.md, init session |
| `POST` | `/api/projects/:id/generate` | — | `202 { streamId }` | Start coder → SSE |
| `POST` | `/api/projects/:id/generate/continue` | — | `202 { streamId }` | Continue after max_turns |
| `POST` | `/api/projects/:id/generate/stop` | — | `200` | Signal coder to stop |
| `POST` | `/api/projects/:id/iterate` | `{ message }` | `202 { streamId }` | Coder iteration → SSE |
| `GET`  | `/api/projects/:id/status` | — | `{ session, tasks, errors }` | Project status |
| `POST` | `/api/projects/:id/up` | — | `202 { streamId }` | Start Docker + migrate + dev |
| `POST` | `/api/projects/:id/down` | — | `200` | Stop Docker |

### SSE Stream

```
GET /api/stream/:streamId
Content-Type: text/event-stream
```

Event types (matching existing LogLevel + extras):

```
event: plan
data: {"message":"Running planner agent..."}

event: task
data: {"message":"Defining projects collection"}

event: tool_use
data: {"tool":"Write","summary":"src/collections/projects.ts"}

event: build
data: {"message":"Build passed","success":true}

event: error
data: {"message":"Cannot find module '@tanstack/db'"}

event: progress
data: {"checked":12,"total":27,"phase":"Phase 2: Collections & API Routes"}

event: agent_text
data: {"text":"I'll add a comments table related to tasks..."}

event: cost
data: {"usd":1.24}

event: done
data: {"success":true,"stopReason":"complete"}

event: max_turns
data: {"message":"Agent needs more turns to finish"}
```

---

## Core Integration: WebProgressReporter

The bridge between existing agents and the web UI. Drop-in replacement for the CLI's `console.log`-based reporter:

```typescript
// src/server/web-reporter.ts
import type { ProgressReporter } from "../progress/reporter.js"
import type { SSEConnection } from "./sse.js"

export function createWebReporter(sse: SSEConnection, debug: boolean): ProgressReporter {
  return {
    debugMode: debug,
    log(level, message) {
      sse.send(level, { message })
    },
    logToolUse(toolName, summary) {
      sse.send("tool_use", { tool: toolName, summary })
    },
  }
}
```

This is passed to `runPlanner()`, `runCoder()`, and `processAgentMessage()` — the exact same interface the CLI uses. **Zero changes to the core agents.**

---

## Frontend State Management

```typescript
interface AppState {
  step: "home" | "clarify" | "plan" | "generate" | "dashboard" | "iterate"
  project: { id: string; name: string; dir: string; description: string } | null
  plan: string | null
  planLoading: boolean
  generation: {
    running: boolean
    tasks: { text: string; status: "done" | "active" | "pending" }[]
    checked: number
    total: number
    phase: string
    buildStatus: "passing" | "failing" | "pending"
    cost: number
    errorCount: number
  }
  log: { level: string; message: string; timestamp: number }[]
  messages: { role: "user" | "agent"; text: string }[]
}
```

Single `useReducer` + React context. SSE events dispatch actions to update state. No external state library.

---

## Project Discovery

`electric-agent ui` scans a base directory (defaults to cwd, configurable with `--projects-dir`) for subdirectories containing `PLAN.md` + `_agent/session.md`. Each matching directory is listed as a project. No global registry, no database — the filesystem is the source of truth, same as the CLI.

---

## Development Workflow

**Dev mode** (two terminals):
```bash
# Terminal 1: API server with watch
npm run dev:server    # tsc --watch + nodemon dist/cli/ui.js

# Terminal 2: Vite dev server for frontend
npm run dev:web       # vite dev (proxies /api → localhost:3456)
```

**Production build:**
```bash
npm run build         # tsc (server) + vite build (web → dist/web/)
electric-agent ui     # Serves dist/web/ + API on single port
```

---

## Implementation Phases

### Phase 1: Server foundation
- [ ] HTTP server with route dispatch (`src/server/index.ts`)
- [ ] SSE connection manager (`src/server/sse.ts`)
- [ ] WebProgressReporter bridge (`src/server/web-reporter.ts`)
- [ ] `electric-agent ui` CLI command (`src/cli/ui.ts`)
- [ ] Project discovery (scan for PLAN.md + _agent/session.md)

### Phase 2: Core API routes
- [ ] `GET /api/projects` — list projects
- [ ] `POST /api/projects` — scaffold (calls existing `scaffold()`)
- [ ] `POST /api/projects/:id/clarify` — clarifier (calls existing `evaluateDescription()`)
- [ ] `POST /api/projects/:id/plan` — planner with SSE (calls existing `runPlanner()`)
- [ ] `POST /api/projects/:id/approve` — write PLAN.md + init session
- [ ] `POST /api/projects/:id/generate` — coder with SSE (calls existing `runCoder()`)
- [ ] `GET /api/projects/:id/status` — read session + plan + errors
- [ ] `POST /api/projects/:id/iterate` — coder iteration with SSE
- [ ] `POST /api/projects/:id/up` and `/down` — Docker lifecycle

### Phase 3: React frontend — shell + home
- [ ] Vite + React + Tailwind setup (`web/`)
- [ ] Layout component (header, breadcrumb navigation)
- [ ] Home page: description textarea, project name input, recent projects list
- [ ] Hash-based client-side routing

### Phase 4: Describe + Clarify flow
- [ ] Submit description → clarifier API
- [ ] Clarification page (conditional, only if confidence < 70)
- [ ] Scaffold trigger on submit

### Phase 5: Plan review + approval
- [ ] SSE hook for planner progress
- [ ] MarkdownViewer component for PLAN.md rendering
- [ ] Approve / Revise / Cancel actions
- [ ] Revision feedback loop (re-run planner)

### Phase 6: Generation progress
- [ ] SSE hook for coder progress
- [ ] TaskList component with live checkbox updates
- [ ] ProgressLog component with auto-scroll
- [ ] Progress bar + phase display
- [ ] BuildBadge, cost counter, error counter
- [ ] Continue/Stop prompt on max_turns

### Phase 7: Dashboard + infrastructure
- [ ] Project status overview (from session + PLAN.md)
- [ ] Error log display (from _agent/errors.md)
- [ ] Up/Down Docker controls
- [ ] Link to open generated app

### Phase 8: Iterate
- [ ] Split-pane layout (conversation + activity)
- [ ] Chat message history
- [ ] SSE streaming for iteration progress
- [ ] Build verification display

---

## Key Design Decisions

1. **SSE over WebSocket** — Progress is unidirectional (server→client). User actions use HTTP POST. SSE has built-in reconnection, simpler error handling, works through proxies. No bidirectional channel needed.

2. **No new framework** — Plain React + Vite for the tool UI. Not TanStack Start (avoids confusion with generated apps). Not Next.js (overkill for a tool interface). This is a dev tool, not a production app.

3. **Single port** — In production, the Node server serves both the Vite-built static files and the API. In dev, Vite proxies `/api` to the Node server. One port for users to remember.

4. **Node `http`, no Express** — The API surface is small (~15 routes). `node:http` with a tiny route matcher avoids adding Express/Fastify as a dependency. Keeps the tool lightweight.

5. **Same `ProgressReporter` interface** — The web reporter is a drop-in replacement that sends events over SSE instead of writing to stdout. Zero changes to agents, hooks, or tools.

6. **Project ID = directory name** — No database, no UUIDs. The project directory is the source of truth, same as the CLI.

7. **AbortController for stopping generation** — The "Stop" button aborts the SSE connection and signals the server to terminate the coder's async iterator. Clean shutdown without orphan processes.

8. **Filesystem-based project listing** — Scan for `PLAN.md` directories rather than maintaining a separate project registry. Consistent with CLI behavior. Projects created via CLI appear automatically in the web UI.
