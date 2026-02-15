# create-electric-app

CLI tool that turns natural-language app descriptions into running reactive [Electric SQL](https://electric-sql.com/) + [TanStack DB](https://tanstack.com/db) applications using Claude as the code generation engine.

```bash
electric-agent new "a project management app with boards and tasks"
```

## How It Works

The agent follows a multi-phase pipeline to go from a text description to a running app:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        electric-agent new                           │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. SCAFFOLD                                                        │
│                                                                     │
│  Clone KPB template ──► Overlay Electric/Drizzle files ──►          │
│  Merge deps (TanStack DB, Electric, Drizzle, Vitest) ──►           │
│  Patch Vite config ──► Install dependencies                         │
│                                                                     │
│  Result: runnable TanStack Start project with Electric infra        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  2. PLAN  (Planner Agent — Claude Opus)                             │
│                                                                     │
│  Reads playbooks (electric-quickstart, tanstack-db) ──►             │
│  Generates PLAN.md with data model + phased tasks                   │
│                                                                     │
│  ┌─ User reviews plan ─┐                                            │
│  │  approve / revise / cancel                                       │
│  └──────────────────────┘                                           │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  3. GENERATE  (Coder Agent — Claude Sonnet)                         │
│                                                                     │
│  Executes PLAN.md tasks in order, reading playbooks just-in-time:   │
│                                                                     │
│  Phase 1: Schema ──────── Drizzle pgTable + Zod derivation          │
│      │                    + drizzle-kit generate/migrate             │
│      ▼                                                              │
│  Phase 2: Collections ─── Electric collections + shape proxies      │
│      │                    + mutation API routes                      │
│      ▼                                                              │
│  Phase 3: Mutations ───── Server-side Drizzle transactions          │
│      │                    + parseDates for JSON round-trip           │
│      ▼                                                              │
│  Phase 4: UI ──────────── React components + useLiveQuery           │
│      │                    + ClientOnly wrappers for SSR safety       │
│      ▼                                                              │
│  Phase 5: Testing ─────── Zod schema smoke tests (no Docker)        │
│                           + collection insert validation            │
│                           + JSON round-trip tests                    │
│                                                                     │
│  After each phase: build tool runs pnpm build + check + test        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  4. RUN                                                             │
│                                                                     │
│  electric-agent up ──► Docker (Postgres + Electric + Caddy) ──►     │
│  drizzle-kit migrate ──► pnpm dev                                   │
└─────────────────────────────────────────────────────────────────────┘
```

### Web UI

The web UI provides a browser-based alternative to the CLI with real-time streaming, collapsible tool execution logs, and persistent session history.

```bash
electric-agent serve               # Start at http://127.0.0.1:4400
electric-agent serve --open        # Start and open browser
electric-agent serve -p 8080       # Custom port
```

The web UI uses [durable-streams](https://github.com/durable-streams/durable-streams) to persist and stream all events over SSE. Each session gets its own stream, so you can close the browser and reconnect without losing context. Tool executions are collapsible — click to expand the full input/output.

### Iteration Mode

After the initial build, use `electric-agent iterate` for conversational changes:

```
┌─────────────────────────────────────────────────────────────────────┐
│  electric-agent iterate                                             │
│                                                                     │
│  iterate> add a sidebar with project navigation                     │
│      │                                                              │
│      ├── Read relevant playbooks (live-queries, etc.)               │
│      ├── Add iteration section to PLAN.md                           │
│      ├── Implement changes (following Drizzle Workflow order)        │
│      ├── Run build + check + test                                   │
│      └── Done                                                       │
│                                                                     │
│  iterate> add dark mode                                             │
│      │                                                              │
│      └── ... (same flow)                                            │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
Drizzle pgTable()
    │
    ▼
drizzle-kit generate ──► SQL migrations (REPLICA IDENTITY FULL auto-appended)
    │
    ▼
drizzle-kit migrate ──► Postgres
    │
    ▼
Electric sync service ◄── watches Postgres WAL
    │
    ▼
/api/<table> proxy route ──► forwards Electric shape stream to client
    │
    ▼
TanStack DB collection ──► validates with Zod selectSchema
    │
    ▼
useLiveQuery() ──► reactive UI (auto-updates on sync)
    │
    ▼
collection.insert/update/delete ──► validates ALL fields client-side
    │                                 (id + timestamps required)
    ▼
/api/mutations/<table> ──► parseDates() ──► Drizzle transaction ──► Postgres
    │
    ▼
Returns { txid } for optimistic update correlation
```

## Guardrail Hooks

The coder agent runs with guardrail hooks that catch common mistakes before they reach the codebase:

| Hook | When | What it does |
|------|------|-------------|
| **write-protection** | PreToolUse (Write/Edit) | Blocks writes to config files (vite.config.ts, docker-compose.yml, vitest.config.ts, etc.) |
| **import-validation** | PreToolUse (Write/Edit) | Catches hallucinated imports (wrong package paths, non-existent modules) |
| **migration-validation** | PreToolUse (Bash) | Auto-appends `REPLICA IDENTITY FULL` to migration SQL |
| **dependency-guard** | PreToolUse (Write/Edit) | Prevents removal of required dependencies from package.json |
| **schema-consistency** | PostToolUse (Write/Edit) | Warns when hand-written Zod schemas are detected (should use drizzle-zod) |

## Custom MCP Tools

| Tool | Description |
|------|-------------|
| `build` | Runs `pnpm build` + `biome check` + `pnpm test` (if tests exist), returns errors |
| `read_playbook` | Reads a playbook skill (SKILL.md + references) |
| `list_playbooks` | Lists all available playbook skills |

## Generated App Structure

```
my-app/
├── docker-compose.yml          # Postgres + Electric + Caddy
├── Caddyfile                   # Reverse proxy (5173 → Vite 5174 + Electric 3000)
├── drizzle.config.ts           # Drizzle Kit config
├── vitest.config.ts            # Vitest with @/ alias
├── PLAN.md                     # Implementation plan (maintained across iterations)
├── drizzle/                    # Generated SQL migrations
├── src/
│   ├── db/
│   │   ├── schema.ts           # Drizzle pgTable definitions
│   │   ├── zod-schemas.ts      # Derived via createSelectSchema/createInsertSchema
│   │   ├── collections/        # TanStack DB + Electric collections
│   │   ├── index.ts            # Drizzle client
│   │   └── utils.ts            # generateTxId + parseDates
│   ├── components/
│   │   └── ClientOnly.tsx      # SSR-safe wrapper for useLiveQuery components
│   ├── routes/
│   │   ├── __root.tsx          # HTML shell (always SSR'd)
│   │   ├── index.tsx           # Home page (ssr: false)
│   │   ├── api/<table>.ts      # Electric shape proxy routes
│   │   └── api/mutations/      # Drizzle transaction routes
│   └── lib/
│       └── electric-proxy.ts   # Shape proxy helper
├── tests/
│   ├── helpers/
│   │   └── schema-test-utils.ts  # generateValidRow, generateRowWithout
│   ├── schema.test.ts          # Zod schema smoke tests
│   ├── collections.test.ts     # Collection insert validation + JSON round-trip
│   └── integration/
│       └── data-flow.test.ts   # Drizzle → Postgres → Zod (requires Docker)
└── _agent/                     # Working memory (errors.md, session.md)
```

## CLI Commands

```bash
electric-agent new <description>          # Create a new app
electric-agent new <desc> --name my-app   # Custom project name
electric-agent new <desc> --no-approve    # Skip plan approval
electric-agent iterate                    # Conversational iteration on existing app
electric-agent serve                      # Start web UI (http://127.0.0.1:4400)
electric-agent serve --open               # Start web UI and open browser
electric-agent serve -p 8080              # Custom port
electric-agent serve --streams-port 5000  # Custom durable-streams port
electric-agent up                         # Start Docker + migrations + dev server
electric-agent down                       # Stop all services
electric-agent status                     # Show project progress
electric-agent --debug <command>          # Enable debug logging
```

## Development

```bash
npm install                   # Install dependencies
npm run build                 # Compile TypeScript + Vite client → dist/
npm run build:server          # Compile TypeScript only
npm run build:web             # Build Vite client only
npm run check                 # Biome lint + format check
npm run check:fix             # Auto-fix Biome issues
npx tsc --noEmit              # Type-check without emitting
npm run dev                   # TypeScript watch mode
npm run dev:web               # Vite dev server with HMR (port 4401)
```

### Dev Environment

To work on the web UI with hot-reload:

```bash
./dev.sh
```

This starts three processes in parallel:
1. `tsc --watch` — recompiles server-side TypeScript on change
2. `node dist/index.js serve` — runs the backend API + durable-streams server (port 4400)
3. `vite dev` — React client with HMR (port 4401), proxies `/api` to the backend

Open http://127.0.0.1:4401 for development (Vite with hot-reload).
Open http://127.0.0.1:4400 for production-like mode (static build served by Hono).

### Source Structure

```
src/
├── index.ts                  # CLI entry point (commander)
├── cli/                      # Command implementations (new, iterate, serve, up, down, status)
├── engine/                   # Shared orchestration (used by CLI + web)
│   ├── events.ts             # EngineEvent union type — single source of truth
│   ├── orchestrator.ts       # runNew() + runIterate() with callback-driven I/O
│   ├── message-parser.ts     # SDK message → EngineEvent[] conversion
│   └── cli-adapter.ts        # OrchestratorCallbacks using readline (CLI mode)
├── agents/
│   ├── planner.ts            # Planner agent (Opus) — generates PLAN.md
│   ├── coder.ts              # Coder agent (Sonnet) — executes plan tasks
│   ├── prompts.ts            # System prompt builders
│   └── patterns.md           # Code patterns + hallucination guards (injected into coder prompt)
├── tools/
│   ├── server.ts             # MCP tool server wrapper
│   ├── build.ts              # Build tool (pnpm build + check + test)
│   └── playbook.ts           # Playbook reading tools
├── hooks/                    # Agent SDK guardrail hooks (6 hooks)
├── scaffold/                 # KPB clone + template overlay + dep merge
├── working-memory/           # Session state + error log persistence
├── progress/                 # CLI output + build result reporting
└── web/                      # Web UI server + client
    ├── server.ts             # Hono API server (REST + static files)
    ├── infra.ts              # Durable streams server lifecycle
    ├── gate.ts               # Promise-based gate management for user decisions
    ├── sessions.ts           # Session index (JSON file)
    └── client/               # React SPA (built with Vite)
        ├── index.html
        ├── vite.config.ts
        └── src/
            ├── main.tsx
            ├── App.tsx
            ├── hooks/useSession.ts
            ├── components/
            └── lib/

template/                     # Files overlaid onto scaffold
├── docker-compose.yml        # Postgres + Electric + Caddy
├── vitest.config.ts          # Vitest config
├── tests/helpers/            # Test utilities (schema-test-utils.ts)
├── src/db/                   # Drizzle client, schema placeholder, utils (parseDates)
├── src/components/           # ClientOnly.tsx
└── src/lib/                  # electric-proxy.ts
```

## Prerequisites

- Node.js >= 20
- Docker (for generated projects)
- `ANTHROPIC_API_KEY` environment variable

## Stack

- [Electric SQL](https://electric-sql.com/) — real-time Postgres sync
- [TanStack DB](https://tanstack.com/db) — reactive collections with optimistic mutations
- [TanStack Start](https://tanstack.com/start) — full-stack React framework
- [Drizzle ORM](https://orm.drizzle.team/) — type-safe Postgres schema and queries
- [KPB](https://github.com/KyleAMathews/kpb) — base project template
- [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) — agentic code generation
- [Durable Streams](https://github.com/durable-streams/durable-streams) — persistent event streaming for the web UI
- [Hono](https://hono.dev/) — lightweight HTTP server for the web API
- [Vite](https://vite.dev/) + [React](https://react.dev/) — web UI client
