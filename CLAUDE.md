# CLAUDE.md

## Project

`create-electric-app` — CLI tool (`electric-agent`) that generates reactive Electric SQL + TanStack DB applications from natural-language descriptions using Claude Agent SDK.

## Build & Lint

```bash
npm install                      # install dependencies
npm run build                    # compile TypeScript → dist/
npm run check                    # Biome lint + format check
npm run check:fix                # auto-fix Biome issues
npx tsc --noEmit                 # type-check without emitting
node dist/index.js --help        # run the CLI
```

## Architecture

```
src/
├── index.ts                     # CLI entry point (commander)
├── cli/                         # Command implementations
│   ├── new.ts                   # `electric-agent new <desc>` — scaffold + plan + generate
│   ├── iterate.ts               # `electric-agent iterate` — conversational iteration
│   ├── status.ts                # `electric-agent status` — show progress
│   ├── up.ts                    # `electric-agent up` — docker + migrations + dev server
│   └── down.ts                  # `electric-agent down` — stop services
├── agents/                      # Agent orchestration via Claude Agent SDK
│   ├── planner.ts               # Planner agent (Opus) — generates PLAN.md
│   ├── coder.ts                 # Coder agent (Sonnet) — executes plan tasks
│   ├── prompts.ts               # System prompt builders for both agents
│   └── patterns.md              # Condensed code patterns injected into coder prompt
├── tools/                       # Custom MCP tools
│   ├── server.ts                # createSdkMcpServer wrapper
│   ├── build.ts                 # `build` tool — runs pnpm build + biome check
│   └── playbook.ts              # `read_playbook` + `list_playbooks` tools
├── hooks/                       # Agent SDK guardrail hooks
│   ├── index.ts                 # Hook registry
│   ├── write-protection.ts      # Block writes to config files
│   ├── import-validation.ts     # Catch hallucinated imports
│   ├── migration-validation.ts  # Auto-append REPLICA IDENTITY FULL
│   ├── dependency-guard.ts      # Prevent dependency removal
│   └── schema-consistency.ts    # Warn on hand-written Zod in collections
├── scaffold/                    # Project scaffolding
│   └── index.ts                 # KPB clone + template overlay + dep merge + install
├── working-memory/              # Agent state persistence
│   ├── session.ts               # Session state (phase, task, build status)
│   └── errors.ts                # Error log with dedup detection
└── progress/                    # CLI output
    └── reporter.ts              # Color-coded progress logging
template/                        # Files overlaid onto KPB scaffold
├── docker-compose.yml           # Postgres + Electric + Caddy
├── Caddyfile                    # Reverse proxy config
├── postgres.conf                # WAL + replication settings
├── drizzle.config.ts            # Drizzle Kit config
├── .env.example                 # DB + Electric connection strings
└── src/
    ├── db/schema.ts             # Placeholder Drizzle schema
    ├── db/zod-schemas.ts        # Placeholder Zod derivation
    ├── db/index.ts              # Drizzle client setup
    ├── db/utils.ts              # generateTxId helper
    └── lib/electric-proxy.ts    # Electric shape proxy helper
```

## Key Patterns

- **Agent SDK**: Uses `query()` with async generator for streaming input (required for MCP tools). Planner uses Opus, Coder uses Sonnet.
- **Hooks**: PreToolUse hooks run before Write/Edit/Bash. PostToolUse hooks run after. Return `{ hookSpecificOutput: { permissionDecision: "deny" } }` to block.
- **MCP Tools**: Defined via `tool()` + `createSdkMcpServer()`. Tool names become `mcp__<server>__<tool>` in allowedTools.
- **Scaffold**: Clones KPB via gitpick, overlays template files, merges deps, deletes stale lockfile, installs.
- **Data flow**: Drizzle pgTable → drizzle-kit generate → SQL → drizzle-kit migrate → Postgres → Electric → TanStack DB collections → useLiveQuery → UI.

## Conventions

- Biome 2.2.4 for linting/formatting (tabs, double quotes, no semicolons)
- Avoid `any` — use `Record<string, unknown>` for untyped SDK inputs
- Template literals preferred over string concatenation
- `const` over `let` where possible
- Imports sorted alphabetically by Biome
