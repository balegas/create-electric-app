# create-electric-app

CLI tool that turns natural-language app descriptions into running reactive applications built on Electric SQL + TanStack DB.

## Quick Start

```bash
npm install
npm run build

# Create a new app
node dist/index.js new "a collaborative todo list with projects and tags"

# Or, if installed globally:
electric-agent new "a collaborative todo list with projects and tags"
```

## Commands

| Command | Description |
| --- | --- |
| `electric-agent new <description>` | Scaffold a project, generate a plan, and build it |
| `electric-agent iterate` | Conversational iteration on an existing project |
| `electric-agent status` | Show current project progress |
| `electric-agent up` | Start Docker services, run migrations, launch dev server |
| `electric-agent down` | Stop Docker services |

### Options

```
electric-agent new "my app" --name my-app     # Custom project name
electric-agent new "my app" --no-approve       # Skip plan approval, build immediately
```

## How It Works

The tool uses the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) with a two-agent architecture:

1. **Planner** (Opus) reads playbook skills and generates a `PLAN.md` with data model definitions and implementation tasks
2. **Coder** (Sonnet) executes each task: writes Drizzle schemas, derives Zod types, creates collections, API routes, and UI components
3. Five **guardrail hooks** protect the generated code from common mistakes

### Data Flow

```
Drizzle pgTable()         <- single source of truth (TypeScript)
    | drizzle-kit generate
SQL migration files        <- REPLICA IDENTITY FULL auto-appended by hook
    | drizzle-kit migrate
Postgres tables            <- Electric syncs from here
    | drizzle-orm/zod
Zod schemas                <- auto-derived via createSelectSchema()
    |
Collections                <- electricCollectionOptions({ schema })
    | useLiveQuery
UI components              <- fully typed end-to-end
```

### Guardrails

| Hook | Event | Purpose |
| --- | --- | --- |
| Write protection | PreToolUse | Blocks modification of config files |
| Import validation | PreToolUse | Catches hallucinated package imports |
| Migration validation | PreToolUse | Auto-appends REPLICA IDENTITY FULL to SQL |
| Dependency guard | PreToolUse | Prevents removal of required packages |
| Schema consistency | PostToolUse | Warns when collections use hand-written Zod |

### Custom MCP Tools

| Tool | Description |
| --- | --- |
| `build` | Runs `pnpm build` + `biome check`, returns errors |
| `read_playbook` | Reads a playbook skill (SKILL.md + references) |
| `list_playbooks` | Lists all available playbook skills |

## Generated Project Structure

```
my-app/
├── docker-compose.yml       # Postgres + Electric + Caddy
├── Caddyfile                # Reverse proxy (shapes + dev server)
├── drizzle.config.ts        # Drizzle Kit configuration
├── drizzle/                 # Generated SQL migrations
├── src/
│   ├── db/
│   │   ├── schema.ts        # Drizzle table definitions
│   │   ├── zod-schemas.ts   # Derived Zod schemas
│   │   ├── collections/     # TanStack DB collections
│   │   └── index.ts         # Drizzle client
│   ├── routes/
│   │   ├── __root.tsx        # Root layout
│   │   ├── index.tsx         # Home page
│   │   ├── api/              # Electric shape proxy routes
│   │   └── api/mutations/    # Write mutation routes
│   └── components/           # React components
├── PLAN.md                  # Implementation plan
└── _agent/                  # Working memory (gitignored)
```

## Development

```bash
npm install
npm run build         # Compile TypeScript
npm run check         # Biome lint + format
npm run check:fix     # Auto-fix lint issues
npm run dev           # Watch mode
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
