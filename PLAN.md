# Electric App Builder — Implementation Plan

## Overview

A CLI tool (`electric-agent`) that turns natural-language app descriptions into running reactive applications built on Electric SQL + TanStack DB. This plan covers Phase 1 of the RFC: Core Generation MVP.

**Key architectural insight:** The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) provides the agentic loop, built-in tools (Read, Write, Edit, Glob, Grep, Bash), sub-agent orchestration, and hooks for guardrails out of the box. We build on top of this rather than implementing our own agent infrastructure. The existing playbook npm packages (`@electric-sql/playbook`, `@tanstack/db-playbook`) provide canonical grounding material — we use them as-is rather than rewriting.

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
│  │ agents: {}    │    │ agents: {}             │ │
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
│    - Write protection                            │
│    - Import validation                           │
│    - SQL migration validation                    │
│    - Dependency guard                            │
│                                                  │
│  Hooks (PostToolUse):                            │
│    - Collection-schema validation (warnings)     │
│    - Error logging to _agent/errors.md           │
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
│   │   ├── sql-validation.ts    # Ensure REPLICA IDENTITY FULL
│   │   ├── collection-schema.ts # Warn on field mismatches (PostToolUse)
│   │   └── dependency-guard.ts  # Prevent removal of template deps
│   ├── scaffold/
│   │   └── index.ts             # Clone KPB template, add Electric deps
│   ├── progress/
│   │   └── reporter.ts          # Transform SDK messages → prefixed CLI output
│   └── working-memory/
│       ├── errors.ts            # Read/write _agent/errors.md
│       └── session.ts           # Read/write _agent/session.md
├── template/                    # Extended KPB starter template
│   ├── docker-compose.yml       # Postgres 17 + Electric + Caddy
│   ├── Caddyfile                # HTTP/2 reverse proxy
│   ├── postgres.conf            # wal_level=logical
│   ├── .env.example             # DATABASE_URL, ELECTRIC_URL
│   ├── src/
│   │   ├── server.ts            # TanStack Start server entry
│   │   ├── start.tsx            # SSR disabled (defaultSsr: false)
│   │   └── lib/
│   │       └── electric-proxy.ts # Proxy helpers (prepareElectricUrl, etc.)
│   └── (inherits from KPB: package.json, vite, biome, tsconfig, routes, etc.)
└── tests/
    ├── hooks/                   # Guardrail hook tests
    ├── tools/                   # Custom tool tests
    └── scaffold/                # Template scaffolding tests
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

### Playbook loading strategy

**Planner receives** (via system prompt — loaded once):
- `electric-quickstart` — project structure, setup patterns
- `tanstack-start-quickstart` — TanStack Start + Electric SSR config, proxy, docker-compose
- `tanstack-db-electric` — Electric collection setup, txid matching, shapes

**Coder receives** (via system prompt — always loaded):
- A condensed `patterns.md` we write ourselves (~100 lines) — import hallucination guard, correct patterns
- Instructions to use `read_playbook` tool for detailed patterns when needed

**Coder loads on demand** (via `read_playbook` tool):
- `tanstack-db-collections` — when creating collections
- `tanstack-db-live-queries` — when writing queries
- `tanstack-db-mutations` — when implementing mutations
- `tanstack-db-schemas` — when defining Zod schemas
- `electric-tanstack-integration` — when wiring Electric + TanStack DB
- `tanstack-start-quickstart` — when setting up routes, SSR, proxy

---

## Template: Extended KPB

The generated project starts from the KPB template (`npx gitpick KyleAMathews/kpb`) extended with Electric + TanStack DB infrastructure. We add these files on top of KPB:

### Files we add to KPB

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Postgres 17 (wal_level=logical), Electric, Caddy |
| `Caddyfile` | HTTP/2 reverse proxy: `:5173` → dev server + Electric |
| `postgres.conf` | `listen_addresses=*`, `wal_level=logical`, `max_replication_slots=10` |
| `.env.example` | `DATABASE_URL`, `ELECTRIC_URL` for local Docker |
| `src/server.ts` | TanStack Start server entry point |
| `src/start.tsx` | `createStart({ defaultSsr: false })` |
| `src/lib/electric-proxy.ts` | `prepareElectricUrl()`, `proxyElectricRequest()` from playbook |

### Dependencies we add to KPB's package.json

| Package | Version | Purpose |
|---------|---------|---------|
| `@tanstack/db` | `0.5.25` | TanStack DB core |
| `@tanstack/react-db` | `0.1.69` | React hooks (useLiveQuery, etc.) |
| `@tanstack/electric-db-collection` | `0.2.31` | electricCollectionOptions |
| `@electric-sql/client` | `1.5.1` | Electric protocol client |
| `postgres` | `latest` | Postgres client for API routes |
| `zod` | `^3.24` | Schema validation |
| `nitro` | `latest` | Server routes for TanStack Start |
| `dbmate` | `latest` | Database migrations |

### KPB's __root.tsx modification

We modify the root route to use `shellComponent` pattern required for SSR-disabled Electric apps:

```tsx
export const Route = createRootRoute({
  head: () => ({ /* existing head config */ }),
  shellComponent: RootDocument,   // Always SSR'd
  component: () => <Outlet />,    // Client-rendered
})

function RootDocument({ children }) {
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
| `@biomejs/biome` | `2.2.4` | Linting (matches KPB) |
| `vite` | `7.3.1` | Build tool (matches KPB) |
| `react` | `19.2.0` | React (matches KPB) |

---

## Migration Tool: dbmate

**Choice: dbmate** — standard SQL files, Docker-friendly, `dbmate wait` for health checks.

Migration file convention: `db/migrations/YYYYMMDDHHMMSS_description.sql`

```sql
-- migrate:up
CREATE TABLE todos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL,
  completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE todos REPLICA IDENTITY FULL;

-- migrate:down
DROP TABLE todos;
```

Template package.json scripts:
```json
{
  "migrate": "dbmate --url $DATABASE_URL --migrations-dir db/migrations up",
  "migrate:create": "dbmate --url $DATABASE_URL --migrations-dir db/migrations new"
}
```

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

- [ ] Create `template/` directory with Electric infrastructure files:
  - `docker-compose.yml` — Postgres 17 + Electric + Caddy
  - `Caddyfile` — reverse proxy config
  - `postgres.conf` — wal_level=logical
  - `.env.example` — local Docker defaults
- [ ] Create `template/src/server.ts` — TanStack Start server entry
- [ ] Create `template/src/start.tsx` — `createStart({ defaultSsr: false })`
- [ ] Create `template/src/lib/electric-proxy.ts` — proxy helpers from `tanstack-start-quickstart` playbook
- [ ] Implement `src/scaffold/index.ts`:
  1. Clone KPB via `npx gitpick KyleAMathews/kpb <target-dir>`
  2. Copy our Electric infrastructure files into the cloned project
  3. Merge additional dependencies into `package.json` (add, never remove)
  4. Modify `__root.tsx` to use `shellComponent` pattern
  5. Copy `.env.example` → `.env`
  6. Create `db/migrations/` directory
  7. Create `_agent/` directory with empty `errors.md` and `session.md`
  8. Append `_agent/` to `.gitignore`
  9. Run `pnpm install`
- [ ] Verify: scaffolded project builds (`pnpm run build` passes)
- [ ] Acceptance: `electric-agent new "test"` creates a building project with Docker, Electric, and all deps installed

### Phase 2: Custom MCP Tools

Build the three custom tools the agents need beyond the built-in set.

- [ ] Implement `src/tools/build.ts` — `build` tool:
  - Runs `pnpm run build && pnpm run check` in the project directory
  - Captures stdout/stderr
  - Parses TypeScript and Biome error output
  - Returns structured result: `{ success: boolean, output: string, errors: string }`
  - Zod schema: `{ project_dir: z.string() }`
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
  - Protected files (after scaffolding): `docker-compose.yml`, `Caddyfile`, `vite.config.ts`, `tsconfig.json`, `biome.json`, `pnpm-lock.yaml`, `postgres.conf`
  - On match: return `{ permissionDecision: "allow" }` but with `updatedInput` that redirects to `/dev/null` (silent reject)
  - Alternative: return `{ permissionDecision: "deny", permissionDecisionReason: "..." }` with `suppressOutput: true` to hide from agent
- [ ] Implement `src/hooks/import-validation.ts` — PreToolUse hook:
  - Matches: `Write|Edit`
  - Extracts import statements from file content being written
  - Checks against known-correct import table:
    ```
    @tanstack/react-db → useLiveQuery, eq, and, or, gt, lt, createCollection, ...
    @tanstack/db → eq, gt, lt, and, or, not, inArray, count, sum, avg, ...
    @tanstack/electric-db-collection → electricCollectionOptions, isChangeMessage, isControlMessage
    @electric-sql/client → ELECTRIC_PROTOCOL_QUERY_PARAMS, ShapeStream, Shape
    @radix-ui/themes → Theme, Container, Flex, Heading, Text, Button, ...
    @tanstack/react-router → createFileRoute, createRootRoute, Link, Outlet, ...
    @tanstack/react-start → createStart
    @tanstack/react-start/server → createServerFileRoute (or server-entry)
    ```
  - On hallucinated import: deny with suggestion
- [ ] Implement `src/hooks/sql-validation.ts` — PreToolUse hook:
  - Matches: `Write|Edit` (on `*.sql` files)
  - For every `CREATE TABLE` statement, verify a corresponding `ALTER TABLE ... REPLICA IDENTITY FULL` exists
  - On missing: deny with specific error
- [ ] Implement `src/hooks/dependency-guard.ts` — PreToolUse hook:
  - Matches: `Write|Edit` (on `package.json`)
  - Parses old and new content, compares dependency lists
  - Allows additions, blocks removals of existing deps
- [ ] Implement `src/hooks/collection-schema.ts` — PostToolUse hook:
  - Matches: `Write|Edit` (on `src/collections/*.ts` or `src/db/collections/*.ts`)
  - After write succeeds: reads the collection file and the corresponding migration
  - Compares schema fields to SQL columns
  - Returns `additionalContext` warning on mismatch (doesn't block)
- [ ] Implement `src/hooks/index.ts` — compose all hooks:
  ```typescript
  export const hooks = {
    PreToolUse: [
      { matcher: "Write|Edit", hooks: [writeProtection, importValidation, sqlValidation, dependencyGuard] },
    ],
    PostToolUse: [
      { matcher: "Write|Edit", hooks: [collectionSchemaValidation] },
    ],
  }
  ```
- [ ] Write tests for each hook
- [ ] Acceptance: Each hook catches its target failure. Write-protection silently rejects. Import validation catches hallucinated imports. SQL validation catches missing REPLICA IDENTITY.

### Phase 4: Patterns File & System Prompts

Write the condensed patterns file and build system prompt constructors.

- [ ] Write `src/agents/patterns.md` (~100 lines):
  - Correct import paths for every package (condensed from playbooks)
  - Hallucination table: wrong import → correct import
  - `createCollection(electricCollectionOptions({...}))` wrapping pattern
  - `shapeOptions: { url: '/api/tablename' }` pattern
  - SSR-safe URL construction: `new URL('/api/x', typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173').toString()`
  - `getKey: (row) => row.id` requirement
  - `onInsert`/`onUpdate`/`onDelete` handler patterns returning `{ txid }`
  - Backend txid extraction: `pg_current_xact_id()::xid::text` inside transaction
  - `ELECTRIC_PROTOCOL_QUERY_PARAMS` proxy pattern
  - `shellComponent` pattern for __root.tsx
  - Common mistakes:
    - Wrong: `import { useQuery } from '@tanstack/react-db'` → Right: `useLiveQuery`
    - Wrong: `import { electricCollectionOptions } from '@tanstack/react-db'` → Right: `from '@tanstack/electric-db-collection'`
    - Wrong: `createCollection({ ...electricCollectionOptions() })` → Right: `createCollection(electricCollectionOptions({}))`
    - Missing `REPLICA IDENTITY FULL` after `CREATE TABLE`
    - Missing `nitro` plugin in vite.config.ts
    - Missing `src/server.ts` and `src/start.tsx`
- [ ] Implement `src/agents/prompts.ts`:
  - `buildCoderPrompt(projectDir)` → string:
    - Role: code generator for Electric + TanStack DB apps
    - Workflow: read PLAN.md → identify next task → load playbooks → generate code → build → verify
    - Inline `patterns.md` content (always loaded)
    - Error classification guide with examples
    - Instruction: check `_agent/errors.md` before any fix attempt
    - Instruction: use `read_playbook` tool for detailed patterns
    - Instruction: mark tasks complete in PLAN.md after build passes
  - `buildPlannerPrompt()` → string:
    - Role: produce detailed implementation plan
    - Include PLAN.md template (from RFC Section 6)
    - Include key content from `electric-quickstart`, `tanstack-start-quickstart`, `tanstack-db-electric` playbooks (pre-loaded, not via tool)
    - Instruction: produce PLAN.md and nothing else
- [ ] Acceptance: Prompts render correctly, include all required sections, patterns.md has no errors vs. actual APIs

### Phase 5: Agent Orchestration

Wire the Agent SDK to run planner and coder.

- [ ] Implement `src/agents/planner.ts`:
  ```typescript
  async function runPlanner(appDescription: string, projectDir: string): Promise<string> {
    const plannerPrompt = buildPlannerPrompt()
    // Load playbook content to embed in prompt
    const playbooks = await loadPlannerPlaybooks(projectDir)

    for await (const message of query({
      prompt: `${appDescription}\n\n${playbooks}`,
      options: {
        model: "claude-opus-4-6",
        systemPrompt: plannerPrompt,
        maxThinkingTokens: 16384,
        allowedTools: ["mcp__electric-agent-tools__read_playbook", "mcp__electric-agent-tools__list_playbooks"],
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
  - Retry budget per error class
- [ ] Acceptance: Planner produces valid PLAN.md. Coder executes tasks with build verification. Error classification and retry logic works.

### Phase 6: CLI Commands

Wire everything together through the CLI.

- [ ] Implement `src/cli/new.ts` — `electric-agent new "description"`:
  1. Parse app description from CLI args
  2. Derive project name (kebab-case) or accept explicit `--name`
  3. Run scaffolding (Phase 1)
  4. Invoke planner → get PLAN.md
  5. Write PLAN.md to project
  6. Print plan to stdout, prompt for approval
  7. On revise: re-invoke planner with feedback
  8. On approve: run coder task loop
  9. On completion: generate README.md + CLAUDE.md, print summary
- [ ] Implement `src/cli/iterate.ts` — `electric-agent iterate`:
  1. Verify we're in a project directory (check for PLAN.md)
  2. Enter conversational loop (readline or stdin)
  3. For each user message: invoke coder with message as task
  4. Stream progress output
- [ ] Implement `src/cli/status.ts` — `electric-agent status`:
  1. Read PLAN.md, parse `- [x]` and `- [ ]` counts
  2. Read `_agent/session.md`
  3. Print summary: phases, tasks done/total, build status
- [ ] Implement `src/cli/up.ts` — `electric-agent up`:
  1. `docker compose up -d`
  2. Wait for health checks (`curl http://localhost:30000/health`)
  3. `pnpm run migrate`
  4. `pnpm dev`
  5. Print access URL
- [ ] Implement `src/cli/down.ts` — `electric-agent down`:
  1. Kill dev server
  2. `docker compose down`
- [ ] Implement `src/progress/reporter.ts`:
  - Transform SDK message stream → prefixed CLI lines
  - `[plan]`, `[approve]`, `[task]`, `[build]`, `[fix]`, `[done]`, `[error]`
  - Parse tool_use blocks for build results
  - Color support (green/red/yellow)
- [ ] Acceptance: Full end-to-end flow: `electric-agent new "a todo app"` → building project

### Phase 7: Generated Documentation

Documentation generation at the end of code generation.

- [ ] README.md generation:
  - Template filled from PLAN.md data model and architecture
  - Quick start: install, up, migrate, dev
  - Architecture section: data flow diagram, entities, sync shapes
  - Stack description
- [ ] CLAUDE.md generation:
  - Project-specific commands
  - Key files with concrete paths from generated code
  - Pattern examples extracted from generated collections, queries, mutations
  - Common mistakes tailored to this project's specific imports
- [ ] Acceptance: Generated docs are accurate, contain correct paths and imports

### Phase 8: Working Memory & Session

Implement the agent's persistent memory across tool calls.

- [ ] Implement `src/working-memory/errors.ts`:
  - `readErrors(projectDir)` — parse `_agent/errors.md`
  - `logError(projectDir, { timestamp, errorClass, file, message, attemptedFix })` — append entry
  - `logOutcome(projectDir, entryIndex, outcome)` — update with result
  - `hasFailedAttempt(projectDir, errorClass, file, message)` — check for prior failure
  - `consecutiveIdenticalFailures(projectDir)` — check for same-error-twice
- [ ] Implement `src/working-memory/session.ts`:
  - `readSession(projectDir)` — parse `_agent/session.md`
  - `updateSession(projectDir, data)` — update metadata
  - Track: app name, current phase, current task, build status, total builds, total errors
- [ ] Integration with coder: after each build tool result, update session and error log
- [ ] Acceptance: Error log persists across agent invocations. Session state is accurate.

### Phase 9: Integration Testing & Polish

End-to-end testing.

- [ ] Test: `electric-agent new "a collaborative todo list with projects"`
  - Plan is generated with correct entities (todos, projects)
  - Code is generated: migrations, collections, proxy routes, pages
  - Build passes
  - Docker services start
  - App loads and syncs
- [ ] Test: `electric-agent iterate` with "add a due date field to todos"
  - New migration created
  - Collection and schema updated
  - UI updated
  - Build passes
- [ ] Test: error recovery — introduce deliberate error, verify classify/retry/fix
- [ ] Test: each guardrail hook catches its target failure
- [ ] Acceptance: >70% first-attempt success, >90% within 3 retries

---

## Key Technical Decisions

### Agent SDK vs. Raw API

The Agent SDK provides the full agentic loop, built-in tools, and hooks. This eliminates ~60% of the code from the original plan (tool registry, tool implementations for read/write/edit/grep/glob/shell, agentic loop, tool dispatch). The trade-off is a dependency on the SDK, but it's Anthropic's official package.

### Template Strategy: Clone + Extend KPB

Rather than bundling a complete template, we clone KPB via `npx gitpick` and add our Electric infrastructure files on top. This means:
- KPB updates flow through automatically (or we can pin to a specific commit)
- We only maintain the Electric-specific additions
- The template is always a valid KPB project before we touch it

### Playbook Strategy: Use Existing npm Packages

The playbook packages (`@electric-sql/playbook`, `@tanstack/db-playbook`) are already comprehensive, well-structured, and maintained by the respective teams. We use them as-is via the `read_playbook` custom tool rather than writing our own. We only write a condensed `patterns.md` for the always-loaded hallucination guard.

### Guardrails as Hooks

Agent SDK hooks provide exactly the right interception points. PreToolUse hooks can deny/modify tool calls before execution. PostToolUse hooks can add context warnings after execution. This is cleaner than wrapping tool implementations because:
- Hooks compose independently
- Built-in tools (Write, Edit) don't need modification
- The agent sees hook feedback as system messages

### Migration Tool: dbmate

dbmate uses standard SQL files with `-- migrate:up` / `-- migrate:down` markers. It supports `DATABASE_URL`, has a `wait` command for Docker, and can dump schema. No ORM, no code generation — just SQL.

---

## Dependencies (CLI Tool)

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | Agent loop, tools, hooks, sub-agents |
| `commander` | CLI argument parsing |
| `zod` | Schema definitions for custom MCP tools |

That's it. The SDK handles everything else.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Agent SDK API changes | Low | High | Pin to specific version. SDK is Anthropic's official product. |
| KPB template changes break scaffold | Medium | Medium | Pin to specific git commit if needed. Test scaffold in CI. |
| Playbook content doesn't match APIs | Low | High | Playbooks are maintained by Electric/TanStack teams. Version-pinned deps. |
| Agent hallucinates imports | Medium | Medium | Import validation hook catches deterministically. Patterns.md covers all packages. |
| Build feedback loop gets stuck | Medium | High | Hard retry limits. Same-error-twice rule. Working memory prevents loops. |
| Docker not available | Medium | Medium | Detect early, clear error message. |
| SSR/hydration issues | Medium | Medium | Template uses `defaultSsr: false` + `shellComponent` pattern from playbooks. |

---

## Success Criteria (from RFC)

- [ ] 3-5 entity CRUD app → building project on first attempt in >70% of cases
- [ ] Building project within 3 retry cycles in >90% of cases
- [ ] No hallucinated imports in generated code
- [ ] Correct collection definitions, working optimistic mutations
- [ ] Developer can iterate without breaking existing functionality
- [ ] Total generation time under 5 minutes for a typical app
