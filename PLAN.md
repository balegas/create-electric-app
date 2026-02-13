# Electric App Builder — Implementation Plan

## Overview

A CLI tool (`electric-agent`) that turns natural-language app descriptions into running reactive applications built on Electric SQL + TanStack DB. This plan covers Phase 1 of the RFC: Core Generation MVP.

**Key architectural insights:**

1. **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) provides the agentic loop, built-in tools, sub-agent orchestration, and hooks for guardrails. We build on top of this — no custom agent infrastructure needed.
2. **Existing playbook npm packages** (`@electric-sql/playbook`, `@tanstack/db-playbook`) provide canonical grounding — we use them as-is.
3. **Drizzle ORM** provides a single source of truth for the data model, with a type chain from schema definition through to UI:

```
Drizzle pgTable()         ← single source of truth (TypeScript)
    ↓ drizzle-kit generate
SQL migration files        ← standard SQL, REPLICA IDENTITY FULL appended by guardrail
    ↓ drizzle-kit migrate
Postgres tables            ← Electric syncs from here
    ↓ drizzle-orm/zod
Zod schemas                ← auto-generated via createSelectSchema()
    ↓
Collection definitions     ← electricCollectionOptions({ schema: zodSchema })
    ↓ useLiveQuery
UI components              ← fully typed end-to-end
```

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  CLI Entry Point (commander)                     │
│  electric-agent new | iterate | status | up | down│
└──────────────┬──────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────┐
│  Agent SDK query()                               │
│                                                  │
│  ┌──────────────┐    ┌────────────────────────┐ │
│  │ Planner       │    │ Coder                  │ │
│  │ (Opus 4.6)    │    │ (Sonnet 4.5)           │ │
│  │ tools: MCP    │    │ tools: built-in + MCP  │ │
│  └──────────────┘    └────────────────────────┘ │
│                                                  │
│  Built-in tools:  Read, Write, Edit, Glob, Grep, │
│                   Bash, Task                     │
│                                                  │
│  Custom MCP tools: build, read_playbook,         │
│                    list_playbooks                 │
│                                                  │
│  Hooks (PreToolUse):                             │
│    - Write protection (config files)             │
│    - Import validation (hallucination guard)     │
│    - Migration validation (REPLICA IDENTITY)     │
│    - Dependency guard (package.json)             │
│                                                  │
│  Hooks (PostToolUse):                            │
│    - Schema consistency check (Drizzle ↔ Zod)   │
│    - Progress reporting                          │
└─────────────────────────────────────────────────┘
```

### What we build vs. what we get for free

**Get for free from Agent SDK:**
- Agentic loop (tool dispatch, multi-turn conversation)
- Built-in tools: Read, Write, Edit, Glob, Grep, Bash
- Sub-agent orchestration (Task tool)
- Extended thinking support
- Token tracking, cost estimation, budget caps
- Streaming messages for progress feedback
- Session resumption
- Prompt caching (automatic)

**What we build:**
- CLI entry point and commands
- Template scaffolding system
- Custom MCP tools: `build`, `read_playbook`, `list_playbooks`
- Guardrail hooks (5 hooks from RFC Section 8)
- System prompts for planner and coder
- Progress reporter (transforms SDK messages to prefixed CLI output)
- Working memory management (`_agent/errors.md`, `_agent/session.md`)

---

## Project Structure

```
create-electric-app/
├── package.json                 # CLI tool: dependencies, bin entry
├── tsconfig.json                # TypeScript config for the tool
├── biome.json                   # Linting for tool source code
├── PLAN.md                      # This file
├── src/
│   ├── index.ts                 # CLI entry point (commander)
│   ├── cli/
│   │   ├── new.ts               # electric-agent new "description"
│   │   ├── iterate.ts           # electric-agent iterate
│   │   ├── status.ts            # electric-agent status
│   │   ├── up.ts                # electric-agent up
│   │   └── down.ts              # electric-agent down
│   ├── agents/
│   │   ├── planner.ts           # Planner: query() with Opus, MCP-only tools
│   │   ├── coder.ts             # Coder: query() with Sonnet, full tools
│   │   └── prompts.ts           # System prompt builders
│   ├── tools/                   # Custom MCP tools
│   │   ├── server.ts            # createSdkMcpServer with all custom tools
│   │   ├── build.ts             # tool(): pnpm build + pnpm check
│   │   └── playbook.ts          # tool(): read_playbook, list_playbooks
│   ├── hooks/                   # Agent SDK hooks (guardrails)
│   │   ├── index.ts             # Compose all hooks
│   │   ├── write-protection.ts  # Block writes to protected files
│   │   ├── import-validation.ts # Validate imports against known-correct table
│   │   ├── migration-validation.ts # Ensure REPLICA IDENTITY FULL in SQL migrations
│   │   ├── schema-consistency.ts   # Warn if collection doesn't use drizzle-orm/zod
│   │   └── dependency-guard.ts  # Prevent removal of template deps
│   ├── scaffold/
│   │   └── index.ts             # Clone KPB template, add Electric + Drizzle deps
│   ├── working-memory/           # Phase 4: persistent memory (before agent orchestration)
│   │   ├── errors.ts            # Read/write _agent/errors.md
│   │   └── session.ts           # Read/write _agent/session.md
│   └── progress/
│       └── reporter.ts          # Transform SDK messages → prefixed CLI output
├── template/                    # Files added on top of KPB
│   ├── docker-compose.yml       # Postgres 17 + Electric + Caddy
│   ├── Caddyfile                # HTTP/2 reverse proxy
│   ├── postgres.conf            # wal_level=logical
│   ├── .env.example             # DATABASE_URL, ELECTRIC_URL
│   ├── drizzle.config.ts        # Drizzle Kit config
│   ├── src/
│   │   ├── server.ts            # TanStack Start server entry
│   │   ├── start.tsx            # SSR disabled (defaultSsr: false)
│   │   ├── db/
│   │   │   ├── schema.ts        # Drizzle schema (pgTable definitions) — placeholder
│   │   │   ├── index.ts         # Database connection (drizzle + postgres.js)
│   │   │   └── utils.ts         # generateTxId() helper
│   │   └── lib/
│   │       └── electric-proxy.ts # prepareElectricUrl, proxyElectricRequest
│   └── (inherits from KPB: package.json, vite, biome, tsconfig, routes, etc.)
└── tests/
    ├── hooks/                   # Guardrail hook tests
    ├── tools/                   # Custom tool tests
    └── scaffold/                # Template scaffolding tests
```

---

## Data Model: Drizzle as Single Source of Truth

### Schema Definition

The agent generates `src/db/schema.ts` with Drizzle `pgTable()` definitions:

```typescript
// src/db/schema.ts
import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core"

export const todos = pgTable("todos", {
  id: uuid().primaryKey().defaultRandom(),
  text: text().notNull(),
  completed: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})
```

### Zod Schema Derivation

Zod schemas are derived from Drizzle tables — never hand-written:

```typescript
// src/db/zod-schemas.ts
import { createSelectSchema, createInsertSchema } from "drizzle-orm/zod"
import { todos } from "./schema"

export const todoSelectSchema = createSelectSchema(todos)
export const todoInsertSchema = createInsertSchema(todos)

export type Todo = typeof todoSelectSchema._type
export type NewTodo = typeof todoInsertSchema._type
```

### Collection Definition

Collections reference the derived Zod schema:

```typescript
// src/db/collections/todos.ts
import { createCollection } from "@tanstack/react-db"
import { electricCollectionOptions } from "@tanstack/electric-db-collection"
import { todoSelectSchema } from "../zod-schemas"

export const todoCollection = createCollection(
  electricCollectionOptions({
    id: "todos",
    schema: todoSelectSchema,
    getKey: (row) => row.id,
    shapeOptions: {
      url: new URL(
        "/api/todos",
        typeof window !== "undefined"
          ? window.location.origin
          : "http://localhost:5173"
      ).toString(),
    },
    onInsert: async ({ transaction }) => {
      const newTodo = transaction.mutations[0].modified
      const res = await fetch("/api/mutations/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newTodo),
      })
      const { txid } = await res.json()
      return { txid }
    },
    // onUpdate, onDelete follow same pattern
  })
)
```

### Server-Side Mutation Route

API routes use Drizzle for type-safe queries:

```typescript
// src/routes/api/mutations/todos.ts
import { createFileRoute } from "@tanstack/react-router"
import { db } from "@/db"
import { todos } from "@/db/schema"
import { generateTxId } from "@/db/utils"

export const Route = createFileRoute("/api/mutations/todos")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const data = await request.json()
        const result = await db.transaction(async (tx) => {
          const txid = await generateTxId(tx)
          const [newTodo] = await tx.insert(todos).values(data).returning()
          return { todo: newTodo, txid }
        })
        return Response.json(result)
      },
    },
  },
})
```

### Migration Workflow

```bash
# Agent modifies src/db/schema.ts, then:
npx drizzle-kit generate    # generates SQL in drizzle/ directory
npx drizzle-kit migrate     # applies to Postgres
```

The migration validation guardrail scans generated `.sql` files and appends `ALTER TABLE ... REPLICA IDENTITY FULL` for any new `CREATE TABLE` statements before `drizzle-kit migrate` runs.

### Database Connection

```typescript
// src/db/index.ts
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema"

const client = postgres(process.env.DATABASE_URL!)
export const db = drizzle(client, { schema })
```

### txid Helper

```typescript
// src/db/utils.ts
import { sql } from "drizzle-orm"

export async function generateTxId(tx: any): Promise<number> {
  const result = await tx.execute(
    sql`SELECT pg_current_xact_id()::xid::text as txid`
  )
  const txid = result[0]?.txid
  if (txid === undefined) throw new Error("Failed to get transaction ID")
  return parseInt(txid as string, 10)
}
```

---

## Grounding: Playbook Strategy

**We do NOT write playbooks from scratch.** The KPB template includes three playbook npm packages as devDependencies:

| Package | CLI | Skills |
|---------|-----|--------|
| `@electric-sql/playbook` | `electric-playbook` | `electric`, `electric-quickstart`, `electric-tanstack-integration`, `electric-security-check`, `electric-go-live`, `deploying-electric`, `tanstack-start-quickstart` |
| `@tanstack/db-playbook` | `db-playbook` | `tanstack-db`, `tanstack-db-collections`, `tanstack-db-electric`, `tanstack-db-live-queries`, `tanstack-db-mutations`, `tanstack-db-schemas`, `tanstack-db-query` |
| `@durable-streams/playbook` | `durable-streams-playbook` | `durable-streams`, `durable-state`, `durable-streams-dev-setup` |

Each playbook is a `SKILL.md` file with optional `references/*.md` deep-dives. The `read_playbook` custom tool reads these files directly from `node_modules/`.

**Gap: Playbooks don't cover Postgres schema management.** No migration tooling, no `REPLICA IDENTITY FULL`, no schema design conventions. Our `patterns.md` and the planner prompt fill this gap with Drizzle-specific patterns.

### Playbook loading strategy

**Planner receives** (via system prompt — loaded once):
- `electric-quickstart` — project structure, setup patterns
- `tanstack-start-quickstart` — TanStack Start + Electric SSR config, proxy, docker-compose
- `tanstack-db-electric` — Electric collection setup, txid matching, shapes
- Drizzle schema patterns and conventions (from our patterns.md)

**Coder receives** (via system prompt — always loaded):
- A condensed `patterns.md` we write ourselves (~120 lines) — import hallucination guard, Drizzle patterns, correct API usage
- Instructions to use `read_playbook` tool for detailed patterns when needed

**Coder loads on demand** (via `read_playbook` tool):
- `tanstack-db-collections` — when creating collections
- `tanstack-db-live-queries` — when writing queries
- `tanstack-db-mutations` — when implementing mutations
- `electric-tanstack-integration` — when wiring Electric + TanStack DB
- `tanstack-start-quickstart` — when setting up routes, SSR, proxy

---

## Template: Extended KPB

The generated project starts from the KPB template (`npx gitpick KyleAMathews/kpb`) extended with Electric + TanStack DB + Drizzle infrastructure.

### Files we add to KPB

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Postgres 17 (wal_level=logical), Electric, Caddy |
| `Caddyfile` | HTTP/2 reverse proxy: `:5173` → dev server + Electric |
| `postgres.conf` | `listen_addresses=*`, `wal_level=logical`, `max_replication_slots=10` |
| `.env.example` | `DATABASE_URL`, `ELECTRIC_URL` for local Docker |
| `drizzle.config.ts` | Drizzle Kit migration config |
| `src/server.ts` | TanStack Start server entry point |
| `src/start.tsx` | `createStart({ defaultSsr: false })` |
| `src/db/index.ts` | Database connection (drizzle + postgres.js) |
| `src/db/schema.ts` | Drizzle schema — placeholder, agent fills in |
| `src/db/zod-schemas.ts` | Derived Zod schemas from Drizzle tables |
| `src/db/utils.ts` | `generateTxId()` helper |
| `src/lib/electric-proxy.ts` | `prepareElectricUrl()`, `proxyElectricRequest()` |

### Dependencies we add to KPB's package.json

| Package | Version | Type | Purpose |
|---------|---------|------|---------|
| `@tanstack/db` | `0.5.25` | prod | TanStack DB core |
| `@tanstack/react-db` | `0.1.69` | prod | React hooks (useLiveQuery, etc.) |
| `@tanstack/electric-db-collection` | `0.2.31` | prod | electricCollectionOptions |
| `@electric-sql/client` | `1.5.1` | prod | Electric protocol client |
| `drizzle-orm` | `0.45.1` | prod | Schema definitions, query builder, Zod generation |
| `postgres` | `^3.4` | prod | Postgres.js client driver |
| `zod` | `^3.24` | prod | Schema validation (peer dep for drizzle-orm/zod) |
| `nitro` | `latest` | prod | Server routes for TanStack Start |
| `drizzle-kit` | `0.31.9` | dev | Migration generation and application |

### KPB's __root.tsx modification

We modify the root route to use `shellComponent` pattern required for SSR-disabled Electric apps:

```tsx
export const Route = createRootRoute({
  head: () => ({ /* existing head config */ }),
  shellComponent: RootDocument,   // Always SSR'd
  component: () => <Outlet />,    // Client-rendered
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head><HeadContent /></head>
      <body>
        <Theme accentColor="blue" grayColor="slate" radius="medium">
          <ThemeProvider>
            <Header />
            {children}
          </ThemeProvider>
        </Theme>
        <Scripts />
      </body>
    </html>
  )
}
```

### Template validation

The template MUST build before the agent writes any app-specific code. Acceptance: `pnpm install && pnpm run build` passes on the bare template.

---

## Pinned Package Versions

| Package | Version | Notes |
|---------|---------|-------|
| `@tanstack/db` | `0.5.25` | Beta — pin to avoid breaking changes |
| `@tanstack/react-db` | `0.1.69` | Includes useLiveQuery, eq, etc. |
| `@tanstack/electric-db-collection` | `0.2.31` | electricCollectionOptions |
| `@electric-sql/client` | `1.5.1` | ELECTRIC_PROTOCOL_QUERY_PARAMS |
| `@tanstack/react-start` | `1.159.2` | TanStack Start framework |
| `@tanstack/react-router` | `1.158.4` | File-based routing |
| `@tanstack/router-plugin` | `1.158.4` | Vite plugin |
| `@radix-ui/themes` | `3.3.0` | UI component library |
| `drizzle-orm` | `0.45.1` | Schema, queries, Zod generation (drizzle-orm/zod) |
| `drizzle-kit` | `0.31.9` | Migration generation + application |
| `postgres` | `^3.4` | Postgres.js driver |
| `@biomejs/biome` | `2.2.4` | Linting (matches KPB) |
| `vite` | `7.3.1` | Build tool (matches KPB) |
| `react` | `19.2.0` | React (matches KPB) |

---

## Implementation Phases

### Phase 0: Project Bootstrap

Set up the CLI tool project itself.

- [ ] Initialize `package.json` with bin entry (`electric-agent`), ESM type, build scripts
- [ ] Configure `tsconfig.json` for Node.js 20+ (ESM, strict, NodeNext)
- [ ] Configure `biome.json` (tabs, double quotes — matching KPB style)
- [ ] Install dependencies:
  - `@anthropic-ai/claude-agent-sdk` — Agent SDK
  - `commander` — CLI argument parsing
  - `zod` — Schema definitions for custom tools
- [ ] Create `src/index.ts` — CLI entry with commander, stub subcommands
- [ ] Verify: `pnpm run build` produces working JS, `electric-agent --help` works
- [ ] Acceptance: CLI shell runs and prints usage

### Phase 1: Template & Scaffolding

Build the extended KPB template and the scaffolding system.

- [ ] Create `template/` directory with Electric + Drizzle infrastructure files:
  - `docker-compose.yml` — Postgres 17 + Electric + Caddy
  - `Caddyfile` — reverse proxy config
  - `postgres.conf` — wal_level=logical
  - `.env.example` — local Docker defaults
  - `drizzle.config.ts` — Drizzle Kit configuration pointing to `src/db/schema.ts`
- [ ] Create `template/src/server.ts` — TanStack Start server entry
- [ ] Create `template/src/start.tsx` — `createStart({ defaultSsr: false })`
- [ ] Create `template/src/db/index.ts` — database connection (`drizzle(postgres(DATABASE_URL), { schema })`)
- [ ] Create `template/src/db/schema.ts` — empty placeholder with example comment
- [ ] Create `template/src/db/zod-schemas.ts` — empty placeholder with example comment
- [ ] Create `template/src/db/utils.ts` — `generateTxId()` helper function
- [ ] Create `template/src/lib/electric-proxy.ts` — proxy helpers from `tanstack-start-quickstart` playbook
- [ ] Implement `src/scaffold/index.ts`:
  1. Clone KPB via `npx gitpick KyleAMathews/kpb <target-dir>`
  2. Copy our Electric + Drizzle infrastructure files into the cloned project
  3. Merge additional dependencies into `package.json` (add, never remove)
  4. Add scripts: `"generate": "drizzle-kit generate"`, `"migrate": "drizzle-kit migrate"`, `"db:push": "drizzle-kit push"`
  5. Modify `vite.config.ts` to add `nitro()` plugin (required for server routes)
  6. Modify `__root.tsx` to use `shellComponent` pattern
  7. Copy `.env.example` → `.env`
  8. Create `_agent/` directory with empty `errors.md` and `session.md`
  9. Append `_agent/` and `drizzle/meta/` to `.gitignore` (`drizzle/meta/` contains internal drizzle-kit snapshots; the `drizzle/*.sql` migration files themselves should be committed)
  10. Run `pnpm install`
- [ ] Verify: scaffolded project builds (`pnpm run build` passes)
- [ ] Acceptance: scaffolded project has all template files, deps installed, builds cleanly

### Phase 2: Custom MCP Tools

Build the three custom tools the agents need beyond the built-in set.

- [ ] Implement `src/tools/build.ts` — `build` tool:
  - Runs `pnpm run build && pnpm run check` in the agent's `cwd` (set by Agent SDK)
  - Captures stdout/stderr
  - Parses TypeScript and Biome error output into structured format
  - Returns: `{ success: boolean, output: string, errors: string }`
  - Zod schema: `{}` (no args — uses agent's working directory)
- [ ] Implement `src/tools/playbook.ts` — `read_playbook` tool:
  - Reads a skill SKILL.md from installed playbook packages
  - Searches `node_modules/@electric-sql/playbook/skills/`, `node_modules/@tanstack/db-playbook/skills/`, `node_modules/@durable-streams/playbook/skills/`
  - Optionally loads reference files from `references/` subdirectory
  - Zod schema: `{ name: z.string(), include_references: z.boolean().optional() }`
- [ ] Implement `src/tools/playbook.ts` — `list_playbooks` tool:
  - Lists all available skills across all playbook packages
  - Returns name + description for each
  - Zod schema: `{}` (no args)
- [ ] Implement `src/tools/server.ts` — MCP server:
  - `createSdkMcpServer({ name: "electric-agent-tools", version: "1.0.0", tools: [buildTool, readPlaybookTool, listPlaybooksTool] })`
- [ ] Write tests for each tool
- [ ] Acceptance: Each tool runs independently with correct output

### Phase 3: Guardrail Hooks

Implement the 5 guardrails from RFC Section 8 as Agent SDK hooks.

- [ ] Implement `src/hooks/write-protection.ts` — PreToolUse hook:
  - Matches: `Write|Edit`
  - Protected files (after scaffolding): `docker-compose.yml`, `Caddyfile`, `vite.config.ts`, `tsconfig.json`, `biome.json`, `pnpm-lock.yaml`, `postgres.conf`, `drizzle.config.ts`
  - On match: deny with `suppressOutput: true` (silent reject — agent doesn't see the error)
- [ ] Implement `src/hooks/import-validation.ts` — PreToolUse hook:
  - Matches: `Write|Edit`
  - Extracts import statements from file content
  - Checks against known-correct import table:
    ```
    @tanstack/react-db      → useLiveQuery, createCollection, eq, and, or, gt, lt, count, sum, ...
    @tanstack/db            → eq, gt, lt, and, or, not, inArray, count, sum, avg, ...
    @tanstack/electric-db-collection → electricCollectionOptions, isChangeMessage, isControlMessage
    @electric-sql/client    → ELECTRIC_PROTOCOL_QUERY_PARAMS, ShapeStream, Shape
    @radix-ui/themes        → Theme, Container, Flex, Heading, Text, Button, ...
    @tanstack/react-router  → createFileRoute, createRootRoute, Link, Outlet, ...
    @tanstack/react-start   → createStart
    drizzle-orm             → sql, eq, and, or, gt, lt, not, inArray, ...
    drizzle-orm/pg-core     → pgTable, pgEnum, uuid, text, varchar, integer, boolean, timestamp, ...
    drizzle-orm/zod         → createSelectSchema, createInsertSchema, createUpdateSchema
    drizzle-orm/postgres-js → drizzle
    ```
  - On hallucinated import: deny with suggestion from the correct table
- [ ] Implement `src/hooks/migration-validation.ts` — PreToolUse hook:
  - Matches: `Bash` (when command contains `drizzle-kit migrate` or `drizzle-kit push`)
  - **Before allowing the command to run:**
    1. Read all `.sql` files in the project's `drizzle/` directory
    2. For every `CREATE TABLE <name>` statement, check if a corresponding `ALTER TABLE <name> REPLICA IDENTITY FULL` exists in the same file
    3. If missing: **write** the `ALTER TABLE ... REPLICA IDENTITY FULL` statements to the end of the migration file using `fs.appendFileSync()` (direct filesystem call, not an agent tool — hooks run in Node.js)
    4. Then return `{ decision: "allow" }` so the migrate command proceeds with the fixed SQL
  - This approach works because hooks run synchronously in the host process and can directly modify files — we don't need the agent to make the fix
- [ ] Implement `src/hooks/dependency-guard.ts` — PreToolUse hook:
  - Matches: `Write|Edit` (on `package.json`)
  - Parses old and new content, compares dependency lists
  - Allows additions, blocks removals of existing deps
- [ ] Implement `src/hooks/schema-consistency.ts` — PostToolUse hook:
  - Matches: `Write|Edit` (on `src/db/collections/*.ts`)
  - After write: verify the collection file imports its schema from `drizzle-orm/zod` derivation (i.e., from `../zod-schemas` or similar), not a hand-written Zod schema
  - Returns `additionalContext` warning if the collection appears to use a hand-written schema instead of the derived one
- [ ] Implement `src/hooks/index.ts` — compose all hooks:
  ```typescript
  export const hooks = {
    PreToolUse: [
      { matcher: "Write|Edit", hooks: [writeProtection, importValidation, dependencyGuard] },
      { matcher: "Bash", hooks: [migrationValidation] },
    ],
    PostToolUse: [
      { matcher: "Write|Edit", hooks: [schemaConsistency] },
    ],
  }
  ```
- [ ] Write tests for each hook
- [ ] Acceptance: Write-protection silently rejects. Import validation catches hallucinated imports. Migration validation auto-fixes missing REPLICA IDENTITY. Schema consistency warns on hand-written schemas.

### Phase 4: Working Memory & Session

Implement the agent's persistent memory across tool calls. This is needed before agent orchestration (Phase 6) because the coder depends on working memory for error tracking and retry logic.

- [ ] Implement `src/working-memory/errors.ts`:
  - `readErrors(projectDir)` — parse `_agent/errors.md`
  - `logError(projectDir, { timestamp, errorClass, file, message, attemptedFix })` — append entry
  - `logOutcome(projectDir, entryIndex, outcome)` — update with result
  - `hasFailedAttempt(projectDir, errorClass, file, message)` — check for prior failure
  - `consecutiveIdenticalFailures(projectDir)` — check for same-error-twice → trigger escalation
- [ ] Implement `src/working-memory/session.ts`:
  - `readSession(projectDir)` — parse `_agent/session.md`
  - `updateSession(projectDir, data)` — update metadata
  - Track: app name, current phase, current task, build status, total builds, total errors, escalations
- [ ] Write tests for working memory modules
- [ ] Acceptance: Error log persists across agent invocations. Session state accurate. Consecutive failure detection works.

### Phase 5: Patterns File & System Prompts

Write the condensed patterns file and build system prompt constructors.

- [ ] Write `src/agents/patterns.md` (~120 lines):
  - **Drizzle patterns:**
    - `pgTable()` with `uuid().primaryKey().defaultRandom()`, `timestamp({ withTimezone: true }).defaultNow()`
    - Foreign keys: `.references(() => otherTable.id, { onDelete: "cascade" })`
    - Schema goes in `src/db/schema.ts`, connection in `src/db/index.ts`
    - Zod derivation: `createSelectSchema(table)` from `drizzle-orm/zod`
    - Migration workflow: edit schema → `npx drizzle-kit generate` → `npx drizzle-kit migrate`
    - Transaction + txid: `db.transaction(async (tx) => { const txid = await generateTxId(tx); ... })`
    - Query patterns: `tx.insert(table).values(data).returning()`, `tx.update(table).set(data).where(eq(table.id, id))`
  - **Electric + TanStack DB patterns:**
    - `createCollection(electricCollectionOptions({...}))` wrapping (not spread)
    - `shapeOptions: { url: new URL("/api/tablename", ...).toString() }` with SSR-safe URL
    - `getKey: (row) => row.id` requirement
    - `onInsert`/`onUpdate`/`onDelete` handler patterns returning `{ txid }`
    - `ELECTRIC_PROTOCOL_QUERY_PARAMS` proxy pattern
  - **TanStack Start patterns:**
    - `shellComponent` in __root.tsx, `defaultSsr: false` in start.tsx
    - `nitro` plugin required in vite.config.ts
    - `src/server.ts` entry point required
    - Route file pattern: `createFileRoute` with `server: { handlers: { GET: fn } }`
    - **Route naming convention:**
      - Electric shape proxy routes: `/api/<tablename>` (GET only — forwards to Electric)
      - Write mutation routes: `/api/mutations/<tablename>` (POST/PUT/DELETE — writes to Postgres via Drizzle)
      - This separation makes it clear which routes are read-path (Electric) vs. write-path (Drizzle)
  - **Import hallucination table:**
    - Wrong: `import { useQuery } from '@tanstack/react-db'` → Right: `useLiveQuery`
    - Wrong: `import { electricCollectionOptions } from '@tanstack/react-db'` → Right: `from '@tanstack/electric-db-collection'`
    - Wrong: `import { createInsertSchema } from 'drizzle-zod'` → Right: `from 'drizzle-orm/zod'` (drizzle-zod is deprecated)
    - Wrong: `createCollection({ ...electricCollectionOptions() })` → Right: `createCollection(electricCollectionOptions({}))`
    - Wrong: `import { drizzle } from 'drizzle-orm'` → Right: `from 'drizzle-orm/postgres-js'`
- [ ] Implement `src/agents/prompts.ts`:
  - `buildCoderPrompt(projectDir)` → string:
    - Role: code generator for Electric + TanStack DB apps using Drizzle ORM
    - Workflow: read PLAN.md → identify next task → load playbooks → generate code → build → verify
    - Inline `patterns.md` content (always loaded)
    - Drizzle workflow instruction: always edit `src/db/schema.ts` first, then derive Zod schemas, then create collections
    - Error classification guide with examples
    - Instruction: check `_agent/errors.md` before any fix attempt
    - Instruction: use `read_playbook` tool for detailed patterns
    - Instruction: after modifying schema.ts, run `npx drizzle-kit generate && npx drizzle-kit migrate`
    - Instruction: mark tasks complete in PLAN.md after build passes
  - `buildPlannerPrompt()` → string:
    - Role: produce detailed implementation plan
    - Include PLAN.md template (from RFC Section 6)
    - Include Drizzle schema conventions: UUID PKs, timestamptz for dates, snake_case table/column names, camelCase TypeScript
    - Include key content from `electric-quickstart`, `tanstack-start-quickstart`, `tanstack-db-electric` playbooks
    - Instruction: plan should specify entities as Drizzle `pgTable()` definitions
    - Instruction: produce PLAN.md and nothing else
- [ ] Acceptance: Prompts render correctly, patterns.md matches actual APIs

### Phase 6: Agent Orchestration

Wire the Agent SDK to run planner and coder.

- [ ] Implement `src/agents/planner.ts`:
  ```typescript
  async function runPlanner(appDescription: string, projectDir: string): Promise<string> {
    const plannerPrompt = buildPlannerPrompt()
    const playbooks = await loadPlannerPlaybooks(projectDir)

    for await (const message of query({
      prompt: `${appDescription}\n\n${playbooks}`,
      options: {
        model: "claude-opus-4-6",
        systemPrompt: plannerPrompt,
        maxThinkingTokens: 16384,
        allowedTools: [
          "mcp__electric-agent-tools__read_playbook",
          "mcp__electric-agent-tools__list_playbooks",
        ],
        mcpServers: { "electric-agent-tools": mcpServer },
        cwd: projectDir,
        maxTurns: 10,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      },
    })) {
      // Stream progress, capture result
    }
    return planMd
  }
  ```
- [ ] Implement `src/agents/coder.ts`:
  ```typescript
  async function runCoder(projectDir: string, task?: string): Promise<CoderResult> {
    const coderPrompt = buildCoderPrompt(projectDir)

    for await (const message of query({
      prompt: task || "Read PLAN.md and execute the next unchecked task.",
      options: {
        model: "claude-sonnet-4-5-20250929",
        systemPrompt: coderPrompt,
        maxThinkingTokens: 8192,
        allowedTools: [
          "Read", "Write", "Edit", "Glob", "Grep", "Bash",
          "mcp__electric-agent-tools__build",
          "mcp__electric-agent-tools__read_playbook",
          "mcp__electric-agent-tools__list_playbooks",
        ],
        mcpServers: { "electric-agent-tools": mcpServer },
        hooks: guardrailHooks,
        cwd: projectDir,
        maxTurns: 30,
        maxBudgetUsd: 2.0,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      },
    })) {
      // Stream progress, handle errors, update working memory
    }
    return result
  }
  ```
- [ ] Implement coder task loop:
  1. Read PLAN.md, find next unchecked task
  2. Invoke coder with task-specific prompt
  3. Monitor build results from message stream
  4. If build fails: classify error, check `_agent/errors.md`, retry or escalate
  5. If build passes: mark task complete in PLAN.md
  6. Move to next task
  7. After all tasks in phase complete: report to developer
- [ ] Implement error handling:
  - Parse build tool results from PostToolUse messages
  - Classify errors (syntax/type/import/architecture/infrastructure/unknown)
  - Log to `_agent/errors.md`
  - Check for consecutive identical failures → escalate
  - Retry budget per error class (syntax: 2, type: 3, import: 3, architecture: 1, infrastructure: 0, unknown: 1)
- [ ] Integration: wire working memory (Phase 4) into coder — after each build tool result, update session and error log
- [ ] Acceptance: Planner produces valid PLAN.md with Drizzle schemas. Coder generates schema → Zod → collections → routes → UI. Build passes.

### Phase 7: CLI Commands

Wire everything together through the CLI.

- [ ] Implement `src/cli/new.ts` — `electric-agent new "description"`:
  1. Parse app description from CLI args
  2. Derive project name (kebab-case) or accept explicit `--name`
  3. Run scaffolding (Phase 1)
  4. Invoke planner → get PLAN.md
  5. Write PLAN.md to project
  6. Print plan to stdout, prompt for approval (approve / revise / cancel)
  7. On revise: collect feedback, re-invoke planner with history
  8. On approve: run coder task loop for each phase
  9. On completion: generate README.md + CLAUDE.md, print summary
- [ ] Implement `src/cli/iterate.ts` — `electric-agent iterate`:
  1. Verify we're in a project directory (check for PLAN.md)
  2. Read PLAN.md and `_agent/session.md` to restore context
  3. Enter conversational loop (readline)
  4. For each user message: invoke coder with message as task
  5. Coder updates PLAN.md if the request changes the plan
  6. Stream progress output
- [ ] Implement `src/cli/status.ts` — `electric-agent status`:
  1. Read PLAN.md, parse `- [x]` and `- [ ]` counts per phase
  2. Read `_agent/session.md`
  3. Print summary: phases, tasks done/total, build status, error count
- [ ] Implement `src/cli/up.ts` — `electric-agent up`:
  1. `docker compose up -d`
  2. Wait for health checks (Postgres ready, Electric `http://localhost:30000/health`)
  3. Trust Caddy's local CA certificate if not already trusted (`caddy trust` or guide user through manual trust)
  4. `npx drizzle-kit migrate` (apply any pending migrations)
  5. `pnpm dev`
  6. Print access URL (https://localhost:5173 with Caddy, or http://localhost:5174)
- [ ] Implement `src/cli/down.ts` — `electric-agent down`:
  1. Kill dev server if running
  2. `docker compose down`
- [ ] Implement `src/progress/reporter.ts`:
  - Transform SDK message stream → prefixed CLI lines
  - Prefixes: `[plan]`, `[approve]`, `[task]`, `[build]`, `[fix]`, `[done]`, `[error]`
  - Parse tool_use blocks: detect build tool calls, file writes, shell commands
  - Color support: green (pass), red (fail), yellow (fix), dim (progress)
- [ ] Acceptance: Full end-to-end flow: `electric-agent new "a todo app"` → building project with Drizzle schema, migrations, collections, and UI

### Phase 8: Generated Documentation

Documentation generation at the end of code generation.

- [ ] README.md generation:
  - Template filled from PLAN.md: app name, description, data model, architecture
  - Quick start: `pnpm install` → `electric-agent up` (or manual: docker compose + migrate + dev)
  - Architecture: data flow diagram, entities from Drizzle schema, sync shapes
  - Stack description with version badges
- [ ] CLAUDE.md generation:
  - Project-specific commands: build, check, generate, migrate, dev
  - Key files with concrete paths from generated code
  - Drizzle schema location and modification workflow
  - Pattern examples extracted from generated collections, queries, mutations
  - Common mistakes tailored to this project's imports
- [ ] Acceptance: Generated docs are accurate, contain correct paths and imports

### Phase 9: Integration Testing & Polish

End-to-end testing.

- [ ] Test: `electric-agent new "a collaborative todo list with projects"`
  - Planner generates plan with correct entities (todos, projects, foreign keys)
  - Drizzle schema generated in `src/db/schema.ts` with `pgTable()` definitions
  - Zod schemas derived in `src/db/zod-schemas.ts` via `createSelectSchema()`
  - Collections reference derived schemas
  - SQL migrations generated and include REPLICA IDENTITY FULL
  - Proxy routes and mutation routes created
  - Build passes
  - Docker services start, migrations apply
  - App loads and syncs data in real-time between tabs
- [ ] Test: `electric-agent iterate` with "add a due date field to todos"
  - `src/db/schema.ts` updated with new column
  - `npx drizzle-kit generate` creates ALTER TABLE migration
  - REPLICA IDENTITY FULL preserved
  - Zod schemas auto-updated
  - Collection and UI updated to show new field
  - Build passes
- [ ] Test: error recovery — introduce deliberate type error, verify classify → retry → fix
- [ ] Test: each guardrail hook catches its target failure
- [ ] Test: import hallucination — verify the agent can't use `drizzle-zod` (deprecated) or `useQuery`
- [ ] Acceptance: >70% first-attempt success, >90% within 3 retries

---

## Key Technical Decisions

### Agent SDK vs. Raw API

The Agent SDK provides the full agentic loop, built-in tools, and hooks — eliminating ~60% of custom code. The trade-off is a dependency on Anthropic's SDK, but it's their official product with stable APIs.

### Template Strategy: Clone + Extend KPB

Clone KPB via `npx gitpick` and overlay Electric + Drizzle infrastructure. KPB updates flow through; we only maintain the additions.

### Drizzle ORM as Single Source of Truth

Drizzle provides the complete type chain: `pgTable()` → SQL migrations → Zod schemas → TanStack DB collections → typed UI. This eliminates the manual schema synchronization that was the biggest correctness risk. Key benefits:
- **No hand-written Zod schemas** — `createSelectSchema()` from `drizzle-orm/zod` derives them
- **Type-safe mutations** — Drizzle query builder catches column/type mismatches at build time
- **Migration generation** — `drizzle-kit generate` produces SQL from schema diffs; no manual SQL
- **The REPLICA IDENTITY guardrail auto-fixes** — we scan generated SQL and inject the ALTER TABLE statements

### Playbook Strategy: Existing npm Packages + Custom Patterns

Playbooks cover Electric → TanStack DB → UI excellently. They don't cover Postgres schema management. Our `patterns.md` fills this gap with Drizzle conventions. We don't fork or rewrite playbooks.

### Guardrails as SDK Hooks

PreToolUse hooks intercept writes before execution. PostToolUse hooks add warnings after. The migration validation hook is the most interesting: it intercepts `drizzle-kit migrate` Bash calls and auto-fixes the generated SQL to include REPLICA IDENTITY FULL, rather than blocking or requiring the agent to write SQL manually.

---

## Dependencies (CLI Tool)

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | Agent loop, tools, hooks, sub-agents |
| `commander` | CLI argument parsing |
| `zod` | Schema definitions for custom MCP tools |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Agent SDK API changes | Low | High | Pin version. Official Anthropic product. |
| KPB template drift | Medium | Medium | Pin to git commit if needed. Test scaffold in CI. |
| Drizzle ORM breaking changes | Low | High | Pin to 0.45.1. Drizzle is stable, widely adopted. |
| `drizzle-orm/zod` API changes | Medium | Medium | Pin version. Feature has been stable since 0.44.0. |
| Agent hallucinates imports | Medium | Medium | Import validation hook + patterns.md hallucination table. |
| drizzle-kit generates incompatible SQL | Low | Medium | Migration validation hook auto-fixes REPLICA IDENTITY. |
| Build feedback loop stuck | Medium | High | Retry limits, same-error-twice rule, working memory. |
| Docker not available | Medium | Medium | Detect early, clear error. |
| SSR/hydration issues | Medium | Medium | Template uses `defaultSsr: false` + `shellComponent`. |

---

## Success Criteria (from RFC)

- [ ] 3-5 entity CRUD app → building project on first attempt in >70% of cases
- [ ] Building project within 3 retry cycles in >90% of cases
- [ ] No hallucinated imports in generated code
- [ ] Correct collection definitions with derived Zod schemas, working optimistic mutations
- [ ] Developer can iterate (add fields, add pages) without breaking existing functionality
- [ ] Total generation time under 5 minutes for a typical app
