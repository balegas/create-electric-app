# electric-agent

CLI tool that turns natural-language app descriptions into running reactive [Electric SQL](https://electric-sql.com/) + [TanStack DB](https://tanstack.com/db) applications using Claude as the code generation engine.

```bash
electric-agent new "a project management app with boards and tasks"
```

## Monorepo Structure

This is a pnpm workspaces monorepo with three packages:

| Package | npm | Description |
|---|---|---|
| `@electric-agent/protocol` | [![npm](https://img.shields.io/npm/v/@electric-agent/protocol)](https://www.npmjs.com/package/@electric-agent/protocol) | Shared event types (`EngineEvent`) and helpers |
| `@electric-agent/studio` | [![npm](https://img.shields.io/npm/v/@electric-agent/studio)](https://www.npmjs.com/package/@electric-agent/studio) | Web UI, sandbox providers, session bridges |
| `@electric-agent/agent` | [![npm](https://img.shields.io/npm/v/@electric-agent/agent)](https://www.npmjs.com/package/@electric-agent/agent) | Electric SQL code generation agent + CLI |

```
packages/
├── protocol/          # @electric-agent/protocol — event contract between agent and studio
├── studio/            # @electric-agent/studio — Hono server, React SPA, sandbox management
│   ├── src/           #   Server code (Hono API, streams, sessions, sandbox providers, bridges)
│   └── client/        #   React SPA (Vite build)
└── agent/             # @electric-agent/agent — CLI entry point, orchestrator, agents, tools
    ├── src/           #   Agent code (orchestrator, planner, coder, hooks, scaffold)
    ├── playbooks/     #   Runtime playbook assets
    └── template/      #   Project template files
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
│                           + JSON round-trip tests                   │
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

### Sandbox Mode (Docker)

Run sessions inside isolated Docker containers instead of on the host machine. Each session spawns a container from the `electric-agent-sandbox` image — all scaffold, planning, coding, and builds happen inside the container. The generated app's dev server is port-mapped to the host, and a "Preview App" link appears in the web UI.

See [Running with Sandbox Mode](#running-with-sandbox-mode) in the Development section for setup instructions.

### Headless Mode

Run the agent via an NDJSON protocol on stdin/stdout — useful for CI/CD, Docker, or programmatic usage:

```bash
electric-agent headless
```

The first line on stdin must be a JSON config object:

```json
{"command":"new","description":"a todo app","projectName":"my-todo"}
```

Or for iteration on an existing project:

```json
{"command":"iterate","projectDir":"/path/to/project","request":"add dark mode"}
```

Events stream as JSON lines on stdout (same `EngineEvent` types as the web UI). When the agent needs user input (plan approval, clarification), it emits a gate event and blocks until you send a response on stdin:

```json
{"gate":"approval","decision":"approve"}
{"gate":"clarification","answers":["answer1","answer2"]}
{"gate":"revision","feedback":"change the schema"}
{"gate":"continue","proceed":true}
```

**Example with Docker:**

```bash
docker run -i --rm \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  electric-agent-sandbox \
  electric-agent headless
```

Then paste the config JSON and interact with gates as needed.

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

## GitHub Integration

Every generated project is initialized as a local git repo automatically. GitHub integration is optional — you can checkpoint locally without ever connecting to GitHub.

### Flows

**New project (no GitHub):**
1. Describe your app → agent scaffolds + generates code → local git repo created with initial commit
2. **Checkpoint** — commit all current changes locally (works without GitHub)
3. **Publish** — prompts for a repo name and visibility (public/private), creates a new GitHub repo on your account, and pushes the code (requires GitHub PAT)
4. **Open PR** — creates a pull request from the feature branch (appears after publishing)

**Resume from GitHub:**
1. From the home page, click **Resume from GitHub** → pick a repo from your account
2. The repo is cloned locally, and if a `PLAN.md` is detected, the agent enters iterate mode with context

### GitHub Personal Access Token (PAT)

A **classic** GitHub PAT is required for publish, PR, resume, and repo listing. Checkpoint (local commit) works without it.

**Required scopes:**
- **`repo`** — create repos, push code, create PRs
- **`read:user`** — verify token and read your GitHub username

Create a token at: https://github.com/settings/tokens/new?scopes=repo,read:user

Enter the token in the web UI **Settings** panel under **GitHub → Personal Access Token**. The token is validated on save via `gh auth login`.

### Git Operations

| Action | What it does | Requires GitHub PAT? |
|--------|-------------|---------------------|
| **Checkpoint** | `git add -A` + `git commit` with auto-generated or custom message | No |
| **Publish** | Creates a GitHub repo via `gh repo create`, pushes on a feature branch | Yes |
| **Open PR** | Pushes latest commits and creates a PR via `gh pr create` | Yes |
| **Resume from GitHub** | Clones a repo via `gh repo clone`, creates a new session | Yes |

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
├── vitest.config.ts            # Vitest config
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
electric-agent headless                   # NDJSON stdin/stdout mode (for Docker/CI)
electric-agent serve                      # Start web UI (http://127.0.0.1:4400)
electric-agent serve --sandbox            # Start web UI with Docker sandboxing
electric-agent serve --open               # Start web UI and open browser
electric-agent serve -p 8080              # Custom port
electric-agent serve --streams-port 5000  # Custom durable-streams port
electric-agent up                         # Start Docker + migrations + dev server
electric-agent down                       # Stop all services
electric-agent status                     # Show project progress
electric-agent --debug <command>          # Enable debug logging
```

## Development

### Quick Start

```bash
pnpm install                     # Install all workspace dependencies
pnpm run build                   # Build all packages (protocol → studio → agent)
pnpm run typecheck               # Type-check all packages
pnpm run check                   # Biome lint + format check
pnpm run check:fix               # Auto-fix Biome issues
pnpm run test                    # Run all tests
```

### Per-Package Commands

```bash
pnpm --filter @electric-agent/protocol run build
pnpm --filter @electric-agent/studio run build        # tsc + vite build (React SPA)
pnpm --filter @electric-agent/studio run build:server  # tsc only (no web client)
pnpm --filter @electric-agent/studio run dev:web       # vite dev server (hot reload)
pnpm --filter @electric-agent/agent run build
pnpm --filter @electric-agent/agent run dev            # tsc --watch
pnpm --filter @electric-agent/agent run test
pnpm --filter @electric-agent/studio run test
```

### Running the Web UI

The server requires Durable Streams credentials. Create a `.env` file at the project root with:

```bash
DS_URL=...           # Durable Streams API URL
DS_SERVICE_ID=...    # Durable Streams service ID
DS_SECRET=...        # Durable Streams JWT secret
```

Build and start the server:

```bash
pnpm run build
pnpm run serve                   # http://127.0.0.1:4400
```

By default, the server uses Docker sandboxes (`SANDBOX_RUNTIME=docker`). The server must run directly on the host (not inside a container) so it can access the Docker daemon.

### Running with Sandbox Mode

Sandbox mode runs each session inside an isolated Docker container instead of on the host machine.

1. **Build the sandbox image** (one-time, rebuild after code changes):

   ```bash
   pnpm run build:sandbox         # Builds electric-agent-sandbox Docker image
   ```

2. **Start the server in sandbox mode:**

   ```bash
   pnpm run serve -- --sandbox    # http://127.0.0.1:4400
   ```

**Authentication** — the sandbox container needs access to the Claude API. Auth is resolved in this order:

1. **`ANTHROPIC_API_KEY`** env var — set it before starting, or enter it in the web UI Settings panel
2. **`CLAUDE_CODE_OAUTH_TOKEN`** env var — if you have an OAuth token directly
3. **macOS Keychain** (automatic) — if you've run `claude login` on macOS, the OAuth token is extracted from the Keychain automatically

On Linux, option 3 is not available — use an API key.

### Working on the Web UI

For development with hot-reload, run these in separate terminals:

```bash
pnpm --filter @electric-agent/agent run dev     # Terminal 1: tsc --watch (server)
pnpm run serve                                  # Terminal 2: backend API (port 4400)
pnpm --filter @electric-agent/studio run dev:web # Terminal 3: Vite HMR (port 4401)
```

Open http://127.0.0.1:4401 for development (Vite with hot-reload, proxies `/api` to the backend).
Open http://127.0.0.1:4400 for production-like mode (static build served by Hono).

### Releasing

Publishing is managed by [Changesets](https://github.com/changesets/changesets) with automated CI via GitHub Actions.

1. Add a changeset to your PR: `pnpm exec changeset` (select bump type + summary)
2. Merge the PR to `main`
3. The `release.yml` workflow creates a "chore: version packages" PR
4. Merge the version PR → workflow publishes to npm with OIDC provenance

## Prerequisites

- Node.js >= 24
- pnpm >= 10
- Docker (for generated projects and sandbox mode)
- `ANTHROPIC_API_KEY` environment variable, or `claude login` on macOS
- [GitHub CLI (`gh`)](https://cli.github.com/) — required for GitHub integration (publish, PR, resume)

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
