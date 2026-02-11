# create-electric-app

CLI tool that turns natural-language app descriptions into running reactive applications built on Electric SQL + TanStack DB.

## Usage

```bash
# Create a new app
electric-agent new "a collaborative todo list with projects and tags"

# Iterate on an existing app
electric-agent iterate

# Check progress
electric-agent status

# Start services and dev server
electric-agent up

# Stop services
electric-agent down
```

## Architecture

The tool uses the Claude Agent SDK with a two-agent architecture:

- **Planner** (Opus) — generates a PLAN.md with data model and implementation tasks
- **Coder** (Sonnet) — executes tasks: writes Drizzle schemas, collections, routes, and UI

### Data Flow

```
Drizzle pgTable()         ← single source of truth
    ↓ drizzle-kit generate
SQL migration files        ← REPLICA IDENTITY FULL auto-appended
    ↓ drizzle-kit migrate
Postgres tables            ← Electric syncs from here
    ↓ drizzle-orm/zod
Zod schemas                ← auto-derived
    ↓
Collections                ← Electric sync + optimistic mutations
    ↓ useLiveQuery
UI components              ← fully typed end-to-end
```

### Guardrails

Five hooks protect the generated code:
1. **Write protection** — blocks modification of config files
2. **Import validation** — catches hallucinated imports
3. **Migration validation** — auto-appends REPLICA IDENTITY FULL
4. **Dependency guard** — prevents removal of required packages
5. **Schema consistency** — warns when collections use hand-written Zod

## Development

```bash
npm install
npm run build
node dist/index.js --help
```

## Stack

- [Electric SQL](https://electric-sql.com/) — real-time Postgres sync
- [TanStack DB](https://tanstack.com/db) — reactive collections with optimistic mutations
- [TanStack Start](https://tanstack.com/start) — full-stack React framework
- [Drizzle ORM](https://orm.drizzle.team/) — type-safe Postgres schema and queries
- [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) — agentic code generation
