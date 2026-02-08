# Electric App Builder — Implementation Plan

## Overview

A CLI tool (`electric-agent`) that turns natural-language app descriptions into running reactive applications built on Electric SQL + TanStack DB. This plan covers the fresh implementation of the tool itself (Phase 1 of the RFC: Core Generation MVP).

The tool is a Node.js/TypeScript CLI that orchestrates Claude API calls with a focused tool set, programmatic guardrails, and a build-verification feedback loop.

---

## Project Structure (the CLI tool itself)

```
create-electric-app/
├── package.json                # CLI tool dependencies
├── tsconfig.json               # TypeScript config for the tool
├── biome.json                  # Linting for tool source code
├── PLAN.md                     # This file
├── README.md                   # How to develop/use the CLI tool
├── playbooks/                  # Grounding material for agents
│   ├── patterns.md             # Import paths, hallucination guard (always loaded)
│   ├── collections.md          # Collection definition patterns
│   ├── live-queries.md         # useLiveQuery API
│   ├── mutations.md            # Optimistic mutation patterns
│   ├── proxy.md                # Server-side API route patterns
│   ├── schemas.md              # SQL migration conventions
│   ├── setup.md                # Docker Compose & infrastructure
│   ├── shapes.md               # Sync shape definitions
│   ├── electric.md             # Architecture overview
│   └── security.md             # Phase 1 security limitations
├── template/                   # KPB starter template (scaffolded into new projects)
│   ├── docker-compose.yml
│   ├── Caddyfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── biome.json
│   ├── .env.template
│   ├── .gitignore
│   └── src/
│       └── routes/
│           └── __root.tsx
├── src/                        # CLI tool source
│   ├── index.ts                # Entry point, CLI command routing
│   ├── cli/                    # Command implementations
│   │   ├── new.ts              # `electric-agent new "description"`
│   │   ├── iterate.ts          # `electric-agent iterate`
│   │   ├── status.ts           # `electric-agent status`
│   │   ├── up.ts               # `electric-agent up`
│   │   └── down.ts             # `electric-agent down`
│   ├── agents/                 # Agent orchestration
│   │   ├── planner.ts          # Planner sub-agent (Opus)
│   │   ├── coder.ts            # Main coder agent (Sonnet)
│   │   ├── loop.ts             # Core agentic loop (tool dispatch, retry)
│   │   └── types.ts            # Shared agent types
│   ├── tools/                  # Tool implementations (what the agents can call)
│   │   ├── registry.ts         # Tool registry and dispatch
│   │   ├── write.ts            # Create new file (with guardrail hooks)
│   │   ├── edit.ts             # Search-and-replace edit
│   │   ├── view.ts             # Read file contents
│   │   ├── grep.ts             # Regex search across project
│   │   ├── glob.ts             # Find files by pattern
│   │   ├── build.ts            # Run pnpm build + check
│   │   ├── shell.ts            # Execute shell commands
│   │   └── playbook.ts         # read_playbook and list_playbooks
│   ├── guardrails/             # Programmatic guardrails
│   │   ├── index.ts            # Guardrail pipeline (compose all checks)
│   │   ├── write-protection.ts # Block writes to protected files
│   │   ├── import-validation.ts# Validate imports against patterns.md
│   │   ├── sql-validation.ts   # Ensure REPLICA IDENTITY FULL
│   │   ├── collection-schema.ts# Verify collection fields match SQL
│   │   └── dependency-guard.ts # Prevent removal of template deps
│   ├── errors/                 # Error handling
│   │   ├── classifier.ts       # Classify build errors by pattern
│   │   └── working-memory.ts   # Read/write _agent/errors.md
│   ├── prompts/                # System prompts
│   │   ├── coder.ts            # Coder system prompt builder
│   │   └── planner.ts          # Planner system prompt builder
│   ├── scaffold/               # Project scaffolding
│   │   ├── index.ts            # Copy template, initialize project
│   │   └── template.ts         # Template file processing
│   ├── progress/               # CLI output
│   │   └── reporter.ts         # Prefixed progress lines
│   └── session/                # Session management
│       └── index.ts            # Read/write _agent/session.md
└── tests/                      # Tests for the CLI tool
    ├── guardrails/
    ├── errors/
    ├── tools/
    └── integration/
```

---

## Implementation Phases

### Phase 0: Project Bootstrap

Set up the CLI tool project itself — build system, dependencies, entry point.

- [ ] Initialize package.json with project metadata, bin entry (`electric-agent`), and TypeScript build script
- [ ] Configure tsconfig.json for Node.js 20+ (ESM, strict, NodeNext module resolution)
- [ ] Configure biome.json for the tool's own source code
- [ ] Install core dependencies:
  - `@anthropic-ai/sdk` — Claude API client
  - `commander` — CLI argument parsing
  - `glob` — file pattern matching (for the glob tool)
  - `fast-glob` — performant globbing
- [ ] Create `src/index.ts` — CLI entry point with commander, registering `new`, `iterate`, `status`, `up`, `down` subcommands as stubs
- [ ] Verify the tool builds: `pnpm run build` produces working JS in `dist/`
- [ ] Acceptance: `npx electric-agent --help` prints usage, `npx electric-agent new --help` prints the new command usage

### Phase 1: Template & Scaffolding

Create the KPB starter template and the scaffolding system that copies it into a new project directory.

- [ ] Create `template/` directory with all KPB starter files:
  - `docker-compose.yml` — Postgres 16 (logical replication), Electric, Caddy
  - `Caddyfile` — HTTP/2 reverse proxy for Electric + dev server
  - `package.json` — TanStack Start, TanStack DB, Electric client, Radix UI, Biome
  - `tsconfig.json` — strict TypeScript for generated projects
  - `vite.config.ts` — TanStack Start vite plugin
  - `biome.json` — formatting and lint rules
  - `.env.template` — DATABASE_URL, ELECTRIC_URL defaults for local Docker
  - `.gitignore` — node_modules, dist, _agent/, .env
  - `src/routes/__root.tsx` — root layout with Radix Theme provider
  - `app.config.ts` — TanStack Start app configuration
- [ ] Implement `src/scaffold/template.ts` — read template directory, process `.template` files (variable substitution for project name)
- [ ] Implement `src/scaffold/index.ts`:
  - Create target directory
  - Copy template files
  - Rename `.env.template` → `.env`
  - Initialize git repo
  - Create `_agent/` directory with empty `errors.md` and `session.md`
  - Add `_agent/` to `.gitignore`
  - Create `db/migrations/` directory
- [ ] Acceptance: `electric-agent new "test"` creates a directory with all template files, `pnpm install && pnpm run build` passes in the generated project (before any app-specific code)

### Phase 2: Playbooks

Write all grounding playbooks. These are the single source of truth for how to build on the stack.

- [ ] Write `playbooks/patterns.md` (~80 lines):
  - Correct import paths for every package
  - Hallucination table: wrong import → correct import
  - `createCollection` wrapping pattern: `createCollection(electricCollectionOptions({...}))`
  - `shapeOptions: { url, params: { table } }` (not shorthand)
  - Common mistakes and their fixes
- [ ] Write `playbooks/collections.md` (~40 lines):
  - Full collection definition example with Electric sync
  - Schema field types mapping to Postgres types
  - Collection ID conventions
- [ ] Write `playbooks/live-queries.md` (~30 lines):
  - `useLiveQuery` import and usage
  - `eq()` import from `@tanstack/react-db` and usage
  - Both `eq(field, value)` and plain JS filter patterns
  - Return type handling
- [ ] Write `playbooks/mutations.md` (~35 lines):
  - Optimistic mutation pattern with `mutate` and `onMutate`
  - Transaction callback pattern
  - Server confirmation handling
- [ ] Write `playbooks/proxy.md` (~45 lines):
  - `createAPIFileRoute` pattern for server-side API routes
  - Request/response handling
  - Postgres query execution from API routes
  - Error handling pattern
- [ ] Write `playbooks/schemas.md` (~30 lines):
  - `CREATE TABLE` conventions
  - `ALTER TABLE ... REPLICA IDENTITY FULL` requirement (after every table)
  - Field type mappings (TypeScript ↔ Postgres)
  - Migration file naming: `NNN_description.sql`
  - Relationship patterns (foreign keys)
- [ ] Write `playbooks/setup.md` (~50 lines):
  - Docker Compose service definitions
  - Postgres logical replication config
  - Electric service configuration
  - Caddy reverse proxy setup
  - Health check patterns
- [ ] Write `playbooks/shapes.md` (~20 lines):
  - Shape definition syntax
  - Table-level shapes
  - Where clause filtering
  - Shape URL construction
- [ ] Write `playbooks/electric.md` (~40 lines):
  - Architecture: Postgres → Electric → HTTP → Client
  - What Electric does and doesn't do
  - Read-path sync (Electric) vs write-path (API routes)
  - Logical replication requirements
- [ ] Write `playbooks/security.md` (~15 lines):
  - Phase 1 limitations: no auth, no row-level security
  - All data is accessible to all clients
  - Suitable for local development and demos only
- [ ] Acceptance: All playbooks exist, are internally consistent, and follow the fixes listed in RFC Section 7 (Playbook Pre-requisites)

### Phase 3: Tool Implementations

Build the tool set that agents use to interact with the generated project.

- [ ] Implement `src/tools/types.ts` — Tool interface: `{ name, description, parameters, execute(args, context) → result }`
- [ ] Implement `src/tools/registry.ts` — Tool registry: register tools, look up by name, generate Anthropic tool definitions for API calls
- [ ] Implement `src/tools/view.ts` — Read file from project directory, template directory, or playbooks. Returns file content or "file not found"
- [ ] Implement `src/tools/write.ts`:
  - Write file to project directory
  - **Hook into guardrail pipeline before writing** (write protection, import validation)
  - Return success/failure (silently reject protected files)
- [ ] Implement `src/tools/edit.ts`:
  - Search-and-replace in existing file
  - `old_text` → `new_text` replacement (must be unique match)
  - **Hook into guardrail pipeline** (same checks as write)
  - Return success/failure with context
- [ ] Implement `src/tools/grep.ts` — Regex search across project files. Returns matching lines with file paths and line numbers
- [ ] Implement `src/tools/glob.ts` — Find files matching a glob pattern in the project. Returns list of matching paths
- [ ] Implement `src/tools/build.ts`:
  - Run `pnpm run build` + `pnpm run check` in the project directory
  - Capture stdout/stderr
  - Parse and format error output for the agent
  - Return structured result: `{ success, stdout, stderr, errors[] }`
- [ ] Implement `src/tools/shell.ts`:
  - Execute arbitrary shell command in project directory
  - 120s timeout
  - Capture stdout/stderr
  - Return structured result
- [ ] Implement `src/tools/playbook.ts`:
  - `read_playbook(name)` — load a playbook by name from the bundled playbooks directory
  - `list_playbooks()` — list all available playbook names with one-line descriptions
- [ ] Acceptance: Each tool can be called independently with test inputs and returns expected results. Tools compose with guardrails correctly.

### Phase 4: Programmatic Guardrails

Build the five guardrails from RFC Section 8. These are deterministic checks — no LLM involved.

- [ ] Implement `src/guardrails/index.ts` — Guardrail pipeline: takes a file write/edit operation, runs it through all applicable guardrails, returns allow/reject
- [ ] Implement `src/guardrails/write-protection.ts`:
  - Maintain list of write-protected files: `docker-compose.yml`, `vite.config.ts`, `tsconfig.json`, `biome.json`, `pnpm-lock.yaml`
  - On write/edit to protected file: silently reject (return success to agent, but don't write)
  - Protection activates after initial scaffolding is complete
- [ ] Implement `src/guardrails/import-validation.ts`:
  - Parse import statements from file content
  - Check each import against known-correct import table (derived from `patterns.md`)
  - Reject file write if unknown import found, with suggestion from hallucination table
  - Return specific error: "Unknown import X — did you mean Y?"
- [ ] Implement `src/guardrails/sql-validation.ts`:
  - Parse SQL migration content
  - For every `CREATE TABLE` statement, verify a corresponding `ALTER TABLE ... REPLICA IDENTITY FULL` exists
  - Reject migration if any table is missing REPLICA IDENTITY
  - Return specific error listing which tables need the ALTER
- [ ] Implement `src/guardrails/collection-schema.ts`:
  - After writing a collection file, extract schema fields from the collection definition
  - Read the corresponding migration file to get SQL column definitions
  - Compare fields — flag mismatches (missing fields, type mismatches)
  - Return warnings (not hard reject — the agent should fix, but the write goes through)
- [ ] Implement `src/guardrails/dependency-guard.ts`:
  - Track the set of dependencies from the template's `package.json`
  - On any write to `package.json`, verify no template dependencies were removed
  - Allow additions, block removals
- [ ] Write tests for each guardrail in `tests/guardrails/`
- [ ] Acceptance: Each guardrail independently catches its target failure mode. Write-protection silently rejects. Import validation catches hallucinated imports. SQL validation catches missing REPLICA IDENTITY. Collection validation catches field mismatches. Dependency guard blocks removals.

### Phase 5: Error Classification & Working Memory

Build the error classification system and the working memory that prevents repeated failures.

- [ ] Implement `src/errors/classifier.ts`:
  - Parse build output (stdout/stderr from build tool)
  - Classify errors into: `syntax`, `type`, `import`, `architecture`, `infrastructure`, `unknown`
  - Pattern matching on error messages:
    - `syntax`: "Parse error", "Unexpected token", "SyntaxError"
    - `type`: "Type", "is not assignable to", "missing property", "does not exist on type"
    - `import`: "Module not found", "Cannot find module", "has no exported member"
    - `architecture`: "Circular dependency", "Cannot be used as a"
    - `infrastructure`: "ECONNREFUSED", "docker", "postgres"
  - Return classified errors with: class, file, message, line number, max retries, escalation path
- [ ] Implement `src/errors/working-memory.ts`:
  - `readErrors(projectDir)` — parse `_agent/errors.md`
  - `logError(projectDir, error)` — append to `_agent/errors.md` with timestamp, classification, attempted fix
  - `logOutcome(projectDir, errorId, outcome)` — update existing entry with fix result
  - `hasFailedAttempt(projectDir, errorClass, file, message)` — check if same error already has a failed fix
  - `consecutiveIdenticalFailures(projectDir, errorClass, file, message)` — check for two identical failures in a row
- [ ] Implement `src/session/index.ts`:
  - `readSession(projectDir)` — parse `_agent/session.md`
  - `writeSession(projectDir, data)` — update session metadata
  - Track: app name, current phase, current task, build status, total builds, total errors, escalations
- [ ] Write tests for classifier with sample build outputs for each error class
- [ ] Acceptance: Classifier correctly categorizes sample errors from each class. Working memory persists across tool calls. Consecutive identical failure detection works.

### Phase 6: System Prompts

Build the system prompt constructors for each agent.

- [ ] Implement `src/prompts/coder.ts`:
  - Fixed portion (~1,400 tokens): role description, workflow instructions, `patterns.md` content (always loaded), error classification guide with examples per class, guardrail rules, instruction to check `_agent/errors.md` before any fix
  - Variable portion: current task from `PLAN.md`, loaded playbooks (1-2 as needed)
  - Build the prompt as a function: `buildCoderPrompt(plan, currentTask, loadedPlaybooks) → string`
- [ ] Implement `src/prompts/planner.ts`:
  - App description from developer
  - Infrastructure playbooks: `schemas.md`, `setup.md`, `shapes.md`, `electric.md`
  - Plan template (from RFC Section 6)
  - Instructions to produce `PLAN.md` and nothing else
  - Build as function: `buildPlannerPrompt(appDescription, playbooks, conversationHistory?) → string`
- [ ] Acceptance: Prompts render correctly, stay within token budgets, include all required sections

### Phase 7: Agent Loop & Orchestration

Build the core agentic loop and the planner/coder orchestration.

- [ ] Implement `src/agents/types.ts`:
  - `AgentMessage` — role + content
  - `ToolCall` — tool name, args, id
  - `ToolResult` — id, content, is_error
  - `AgentConfig` — model, system prompt, tools, max_turns
  - `AgentContext` — project directory, session state, plan reference
- [ ] Implement `src/agents/loop.ts` — Core agentic loop:
  - Send messages to Claude API with tools
  - Receive response, check for tool_use blocks
  - Execute each tool call via tool registry
  - Collect tool results, send back as next turn
  - Loop until: assistant responds without tool calls (done), max turns reached, or escalation triggered
  - Handle prompt caching: stable prefix (system prompt) separate from variable suffix
  - Token tracking for cost estimation
- [ ] Implement `src/agents/planner.ts` — Planner sub-agent:
  - Model: `claude-opus-4-6` with extended thinking, effort `high`
  - Tools: `read_playbook`, `list_playbooks` only
  - Input: app description + playbook content
  - Output: structured `PLAN.md` content
  - Parse output into plan structure
  - Approval flow: return plan to caller, caller presents to developer
- [ ] Implement `src/agents/coder.ts` — Main coder agent:
  - Model: `claude-sonnet-4-5-20250929` with extended thinking, effort `high`
  - Tools: all tools (write, edit, view, grep, glob, build, shell, read_playbook, list_playbooks)
  - Workflow per task:
    1. Read `PLAN.md`, identify next unchecked task
    2. Load relevant playbooks for the task
    3. Generate/modify files
    4. Run build tool
    5. If pass → mark task complete in `PLAN.md`, return success
    6. If fail → classify error, check working memory, attempt fix within retry budget
    7. If retry exhausted → escalate per classification table
  - After each build: update `_agent/session.md`
  - Error handling: read `_agent/errors.md` before any fix attempt
  - Same-error-twice detection → immediate escalation
- [ ] Acceptance: Planner produces valid PLAN.md from a test description. Coder can execute a single task (write file + build + verify). Retry logic works with classified errors.

### Phase 8: CLI Commands

Wire everything together through the CLI commands.

- [ ] Implement `src/cli/new.ts` — `electric-agent new "description"`:
  1. Parse app description from args
  2. Create project directory (kebab-case from description or explicit name)
  3. Scaffold from template (Phase 1)
  4. Run `pnpm install` in scaffolded project
  5. Invoke planner with description → get `PLAN.md`
  6. Write `PLAN.md` to project
  7. Present plan to developer (print to stdout)
  8. Prompt for approval (stdin: approve / revise / cancel)
  9. If revise → collect feedback, re-invoke planner with history
  10. If approve → invoke coder for each phase/task in plan
  11. Stream progress output throughout
  12. On completion: print summary (tasks done, build status, how to run)
- [ ] Implement `src/cli/iterate.ts` — `electric-agent iterate`:
  1. Verify we're in a project directory (check for `PLAN.md`)
  2. Read `PLAN.md` and `_agent/session.md` to restore context
  3. Enter conversational loop (readline)
  4. For each user message: invoke coder with context + request
  5. Coder updates `PLAN.md` if the request changes the plan
  6. Coder modifies files and verifies build
  7. Stream progress output
- [ ] Implement `src/cli/status.ts` — `electric-agent status`:
  1. Read `PLAN.md`, parse task completion
  2. Read `_agent/session.md` for session metadata
  3. Print: phases, tasks (done/total), current build status, error count
- [ ] Implement `src/cli/up.ts` — `electric-agent up`:
  1. Run `docker compose up -d` in project directory
  2. Wait for health checks (Postgres, Electric, Caddy)
  3. Run migrations: `pnpm run migrate`
  4. Start dev server: `pnpm dev`
  5. Print access URL
- [ ] Implement `src/cli/down.ts` — `electric-agent down`:
  1. Stop dev server if running
  2. Run `docker compose down`
- [ ] Implement `src/progress/reporter.ts`:
  - Prefixed output: `[plan]`, `[approve]`, `[task]`, `[build]`, `[fix]`, `[done]`, `[error]`
  - Streaming: lines appear as they happen, not batched
  - Color support (optional): green for pass, red for fail, yellow for fix
- [ ] Acceptance: Full end-to-end flow works — `electric-agent new "a todo app"` produces a building project with real-time sync

### Phase 9: Generated Documentation

Implement the documentation generation that runs at the end of code generation.

- [ ] Implement README.md generation:
  - Template with dynamic sections filled from `PLAN.md`
  - Quick start instructions
  - Architecture section: data model, sync shapes, mutation flow
  - Stack description
- [ ] Implement CLAUDE.md generation:
  - Project-specific version of playbook patterns
  - Concrete imports and file paths from the generated code
  - Commands reference
  - Key files listing
  - Pattern examples extracted from generated code
  - Common mistakes section
- [ ] Acceptance: Generated docs are accurate for the specific project, contain correct paths and imports

### Phase 10: Integration Testing & Polish

End-to-end testing of the full flow.

- [ ] Integration test: `electric-agent new "a collaborative todo list"`:
  - Plan is generated and coherent
  - Code is generated for all plan tasks
  - Build passes
  - Docker services start
  - App loads in browser
  - Data syncs in real-time between two tabs
- [ ] Integration test: `electric-agent iterate` with "add a due date field":
  - Migration is created with ALTER TABLE
  - Collection is updated
  - UI shows new field
  - Build passes
  - Existing data is preserved
- [ ] Error recovery test: introduce a deliberate error and verify the agent classifies, retries, and fixes
- [ ] Guardrail tests: verify each guardrail catches its target failure
- [ ] Acceptance: >70% first-attempt success rate on 3-5 entity CRUD apps, >90% within 3 retries

---

## Key Technical Decisions

### Anthropic SDK Usage

Use `@anthropic-ai/sdk` directly. The agentic loop is simple enough that a framework adds overhead without benefit. Key API features:
- **Tool use**: Define tools as JSON schemas, receive `tool_use` content blocks, return `tool_result` blocks
- **Extended thinking**: Enable for both planner (Opus) and coder (Sonnet) with `thinking: { type: "enabled", budget_tokens: N }`
- **Prompt caching**: Structure system prompts with stable prefix for cache hits
- **Streaming**: Use streaming for progress feedback during generation

### Template Strategy

The KPB template is copied verbatim. No templating engine — just file copy with `.env.template` → `.env` rename and project name substitution in `package.json`. The template is a valid, building project before the agent writes any app-specific code. This means:
- `pnpm install && pnpm run build` passes on the bare template
- The agent only adds to the template, never modifies its core files (enforced by write-protection guardrail)

### Migration Execution

Migrations run via a simple `pnpm run migrate` script defined in the template's `package.json`. The script reads SQL files from `db/migrations/` in order and executes them against the Postgres instance. No migration framework — plain SQL files, numbered ordering.

### Error Escalation UX

When the agent escalates to the developer:
1. Print the error clearly with classification
2. Print what was tried and why it failed
3. Ask the developer for guidance
4. Developer can: provide a fix hint, skip the task, or abort

The agent never silently gives up. Every escalation is visible.

---

## Dependencies

### CLI Tool Dependencies (create-electric-app/package.json)

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/sdk` | Claude API client |
| `commander` | CLI argument parsing |
| `fast-glob` | File globbing for glob tool |
| `typescript` | Build-time type checking |

### Generated Project Dependencies (template/package.json)

| Package | Purpose |
|---------|---------|
| `@tanstack/react-start` | TanStack Start framework |
| `@tanstack/react-router` | File-based routing |
| `@tanstack/react-db` | Reactive client store |
| `@tanstack/db` | TanStack DB core |
| `@electric-sql/client` | Electric sync client |
| `@radix-ui/themes` | UI component library |
| `postgres` | Postgres client (for API routes) |
| `vite` | Build tool |
| `typescript` | Type checking |
| `@biomejs/biome` | Lint and format |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Playbook content is wrong/outdated | Medium | High | Test each playbook against actual Electric + TanStack DB APIs before using. Pin to specific package versions in template. |
| Agent hallucinates imports despite guardrails | Medium | Medium | Import validation guardrail catches this deterministically. Keep hallucination table in patterns.md comprehensive. |
| Template project doesn't build | Low | Critical | Test template in CI. Template must be a passing build before anything else. |
| Claude API rate limits during generation | Medium | Medium | Implement exponential backoff. Typical project is ~20 API calls, well within limits. |
| Docker not available on developer's machine | Medium | Medium | Detect early, provide clear error message with install instructions. |
| Build feedback loop gets stuck | Medium | High | Hard limit on retries per error class. Same-error-twice rule. Working memory prevents loops. |

---

## Success Criteria (from RFC)

- [ ] Given a 3-5 entity CRUD app description → building project on first attempt in >70% of cases
- [ ] Building project within 3 retry cycles in >90% of cases
- [ ] No hallucinated imports in generated code
- [ ] Correct collection definitions, working optimistic mutations
- [ ] Developer can iterate without breaking existing functionality
- [ ] Total generation time under 5 minutes for a typical app
