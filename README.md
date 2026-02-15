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
electric-agent up                         # Start Docker + migrations + dev server
electric-agent down                       # Stop all services
electric-agent status                     # Show project progress
electric-agent --debug <command>          # Enable debug logging
```

## Development

```bash
npm install                   # Install dependencies
npm run build                 # Compile TypeScript → dist/
npm run check                 # Biome lint + format check
npm run check:fix             # Auto-fix Biome issues
npx tsc --noEmit              # Type-check without emitting
npm run dev                   # Watch mode
```

### Source Structure

```
src/
├── index.ts                  # CLI entry point (commander)
├── cli/                      # Command implementations (new, iterate, up, down, status)
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
└── progress/                 # CLI output + build result reporting

template/                     # Files overlaid onto scaffold
├── docker-compose.yml        # Postgres + Electric + Caddy
├── vitest.config.ts          # Vitest config
├── tests/helpers/            # Test utilities (schema-test-utils.ts)
├── src/db/                   # Drizzle client, schema placeholder, utils (parseDates)
├── src/components/           # ClientOnly.tsx
└── src/lib/                  # electric-proxy.ts
```

## Deployment (Hosted Generation Service)

The hosted service lets users generate apps via a web UI without local setup. It runs as two components:

- **Web UI** — TanStack Start on Cloudflare Pages (free)
- **API server** — Hono on Fly.io (manages sandbox machines, SSE streaming, downloads)

### Architecture

```
Browser ──> Cloudflare Pages (web UI)
                │
                ▼
            Fly.io API server
                │
                ├── POST /api/sessions     → create Fly Machine sandbox
                ├── GET  /api/progress/:id → SSE proxy from sandbox
                ├── GET  /api/download/:id → signed download URL
                └── POST /api/deploy/:id   → deploy generated app
                │
                ▼
            Fly Machine (per-session, ephemeral)
                └── Agent SDK + electric-agent CLI
```

### Prerequisites

1. [Fly.io account](https://fly.io) with `flyctl` installed
2. [Cloudflare account](https://dash.cloudflare.com) with `wrangler` installed
3. [Tigris object storage](https://fly.io/docs/tigris/) bucket (for download hosting)

### Initial setup

```bash
# 1. Create the Fly app
cd api
fly apps create electric-agent-api
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
fly secrets set FLY_API_TOKEN=$(fly tokens create deploy)
fly secrets set TIGRIS_ACCESS_KEY=...
fly secrets set TIGRIS_SECRET_KEY=...

# 2. Deploy the API server
fly deploy --config fly.toml

# 3. Connect the web UI to Cloudflare Pages
cd ../web
npm install
npx wrangler pages project create electric-agent
npm run deploy
```

### Environment Variables

#### GitHub Actions Secrets

| Secret | Where | Description |
|--------|-------|-------------|
| `FLY_API_TOKEN` | GitHub → Settings → Secrets | Fly.io deploy token (`fly tokens create deploy`) |
| `CLOUDFLARE_API_TOKEN` | GitHub → Settings → Secrets | Cloudflare API token with Pages edit permission |

#### GitHub Actions Variables

| Variable | Where | Description |
|----------|-------|-------------|
| `CLOUDFLARE_ACCOUNT_ID` | GitHub → Settings → Variables | Your Cloudflare account ID (dashboard URL) |
| `API_URL` | GitHub → Settings → Variables | `https://electric-agent-api.fly.dev` |

#### Fly.io Secrets (API server)

Set via `fly secrets set` in the `api/` directory:

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key for running the planner + coder agents |
| `FLY_API_TOKEN` | Fly Machines API token (to create per-session sandbox machines) |
| `TIGRIS_ACCESS_KEY` | Tigris S3-compatible access key (for hosting download archives) |
| `TIGRIS_SECRET_KEY` | Tigris S3-compatible secret key |

#### Cloudflare Pages Environment Variables

Set via Cloudflare dashboard → Pages → electric-agent → Settings → Environment variables:

| Variable | Description |
|----------|-------------|
| `API_URL` | URL of the Fly API server (e.g., `https://electric-agent-api.fly.dev`) |

### Deployment workflows

| Workflow | Trigger | What it deploys |
|----------|---------|-----------------|
| `ci.yml` | Push to main, PRs | Build + lint + test (CLI tool) |
| `deploy-web.yml` | Push to main (web/ or api/ changes) | API to Fly.io + Web UI to Cloudflare Pages |

Cloudflare Pages also auto-deploys per-PR preview URLs when connected to a GitHub repo — no extra config needed for the web UI.

### Estimated costs

| Component | Cost |
|-----------|------|
| Cloudflare Pages (web UI) | Free (unlimited sites, 500 builds/mo) |
| Fly.io API server | ~$2/mo (shared-cpu-1x, 512MB, auto-suspend) |
| Fly.io sandbox machines | ~$0.05/hr per active generation session |
| Tigris storage | Free tier covers initial usage |

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
