# Architecture

## System Overview

Electric Agent is a multi-agent platform organized as a pnpm monorepo with three packages:

```
@electric-agent/protocol  →  @electric-agent/studio  →  @electric-agent/agent
     (event types)              (web UI + sandboxes)       (CLI + code gen + scaffold)
```

The **protocol** package defines the event contract. The **studio** package runs the web server, manages sandboxes and bridges, and serves the React SPA. The **agent** package provides the CLI, project scaffolding, and playbook assets.

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
  │     ├── Create bridge (stream / claude-code)
  │     └── Send "new" command to agent
  │
  ├── GET /api/sessions/:id/events?token=...   ← SSE stream
  │
  ├── POST /api/sessions/:id/iterate           ← follow-up instructions
  │     Authorization: Bearer <sessionToken>
  │
  └── POST /api/sessions/:id/respond           ← resolve gates
        Authorization: Bearer <sessionToken>
```

## App Generation Pipeline

When a user describes an app, the agent follows a multi-phase pipeline:

```
1. SCAFFOLD
   Clone template → overlay Electric/Drizzle files → merge deps → install

2. PLAN  (Claude Opus)
   Read playbooks → generate PLAN.md with data model + phased tasks
   → User reviews: approve / revise / cancel

3. GENERATE  (Claude Sonnet)
   Execute PLAN.md tasks in order:
     Phase 1: Schema ──── Drizzle pgTable + Zod + migrations
     Phase 2: Collections ── Electric collections + shape proxies
     Phase 3: Mutations ──── Server-side Drizzle transactions
     Phase 4: UI ─────────── React components + useLiveQuery
     Phase 5: Testing ────── Zod smoke tests + collection validation

4. RUN
   Start dev server → user previews the app
```

## Data Flow (Generated Apps)

```
Drizzle pgTable()
    │
    ▼
drizzle-kit generate  →  SQL migrations (REPLICA IDENTITY FULL)
    │
    ▼
drizzle-kit migrate  →  Postgres
    │
    ▼
Electric sync service  ←  watches Postgres WAL
    │
    ▼
/api/<table> proxy route  →  forwards Electric shape stream to client
    │
    ▼
TanStack DB collection  →  validates with Zod selectSchema
    │
    ▼
useLiveQuery()  →  reactive UI (auto-updates on sync)
    │
    ▼
collection.insert/update/delete  →  client-side validation
    │
    ▼
/api/mutations/<table>  →  parseDates()  →  Drizzle transaction  →  Postgres
    │
    ▼
Returns { txid } for optimistic update correlation
```

## Key Design Decisions

### Stateless Authentication
All tokens are derived via HMAC-SHA256 from a single secret (`DS_SECRET`). No token database. See [Security](./security.md).

### Sandbox Isolation
Every session runs in its own sandbox. Generated code never touches the host machine. The sandbox provider abstraction makes it possible to swap between Docker (local), Sprites (Fly.io), and Daytona (cloud) without changing application code. See [Sandboxes & Bridges](./sandboxes-and-bridges.md).

### Persistent Event Streaming
Durable Streams provide an append-only event log per session. This enables reconnect catch-up, full replay, and multi-writer support (both server and agent write to the same stream). See [Protocol](./protocol.md).

### Multi-Agent via Room Router
Rather than direct agent-to-agent connections, all communication goes through a central Room Router that watches a shared stream, parses message conventions, and delivers messages via bridges. This keeps agents unaware of infrastructure details. See [Multi-Agent Rooms](./multi-agent.md).

### Guardrail Hooks
The coder agent runs with Claude Code hooks that catch common mistakes:

| Hook | Purpose |
|------|---------|
| write-protection | Blocks writes to config files |
| import-validation | Catches hallucinated imports |
| migration-validation | Auto-appends REPLICA IDENTITY FULL to SQL |
| dependency-guard | Prevents removal of required dependencies |
| schema-consistency | Warns on hand-written Zod schemas |

## CLI Commands

```bash
electric-agent new <description>          # Create a new app
electric-agent new <desc> --name my-app   # Custom project name
electric-agent new <desc> --no-approve    # Skip plan approval
electric-agent iterate                    # Conversational iteration
electric-agent headless                   # NDJSON stdin/stdout mode (Docker/CI)
electric-agent serve                      # Start web UI (port 4400)
electric-agent serve --sandbox            # Web UI with Docker sandboxing
electric-agent serve --open               # Web UI + open browser
electric-agent serve -p 8080              # Custom port
electric-agent up                         # Start Docker + migrations + dev server
electric-agent down                       # Stop all services
electric-agent status                     # Show project progress
```

## Generated App Structure

```
my-app/
├── docker-compose.yml          # Postgres + Electric + Caddy
├── Caddyfile                   # Reverse proxy
├── drizzle.config.ts           # Drizzle Kit config
├── vitest.config.ts            # Vitest config
├── PLAN.md                     # Implementation plan
├── drizzle/                    # Generated SQL migrations
├── src/
│   ├── db/
│   │   ├── schema.ts           # Drizzle pgTable definitions
│   │   ├── zod-schemas.ts      # Derived via drizzle-zod
│   │   ├── collections/        # TanStack DB + Electric collections
│   │   ├── index.ts            # Drizzle client
│   │   └── utils.ts            # generateTxId + parseDates
│   ├── components/
│   │   └── ClientOnly.tsx      # SSR-safe wrapper
│   ├── routes/
│   │   ├── __root.tsx          # HTML shell (always SSR)
│   │   ├── index.tsx           # Home page (ssr: false)
│   │   ├── api/<table>.ts      # Electric shape proxy routes
│   │   └── api/mutations/      # Drizzle transaction routes
│   └── lib/
│       └── electric-proxy.ts   # Shape proxy helper
└── tests/
    ├── schema.test.ts          # Zod schema smoke tests
    ├── collections.test.ts     # Collection validation + JSON round-trip
    └── helpers/
        └── schema-test-utils.ts
```
