---
name: iterate-app
description: Iterate on an existing Electric SQL + TanStack DB application. Handles feature additions, refactoring, bug fixes, UI changes, schema migrations, and more. Use this when modifying an existing project that was previously generated.
argument-hint: <iteration request>
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Agent, WebSearch, TodoWrite
---

# Iterate on Electric SQL App

You are modifying an existing reactive, real-time application built with Electric SQL + TanStack DB + Drizzle ORM inside a TanStack Start project.

Follow the phases below **in strict order**. Do NOT skip phases or jump ahead.

## Phase 0: Understand the Project

Before making any changes, build a mental model of the existing project.

1. **Read `ARCHITECTURE.md`** (if it exists) — this is the project's navigation index. It tells you:
   - All entities, their columns, and relations
   - All API routes (proxy + mutation)
   - All UI routes and components
   - Styling approach

2. **If no `ARCHITECTURE.md`**, read these files to understand the project:
   - `package.json` — project name, dependencies
   - `src/db/schema.ts` — existing Drizzle table definitions
   - `src/db/zod-schemas.ts` — existing Zod schema derivations
   - `src/routes/` — existing page and API routes (use Glob to list them)
   - `src/db/collections/` — existing collections (use Glob to list them)

3. **Read `PLAN.md`** (if it exists) — the previous implementation plan

Do NOT scan the entire filesystem. Use `ARCHITECTURE.md` and targeted reads.

## Phase 1: Understand the Iteration Request

Evaluate `$ARGUMENTS` (the user's iteration request).

**Categorize the request:**
- **Schema change**: Adding/modifying/removing tables, columns, relations
- **Feature addition**: New UI routes, API endpoints, collections, components
- **Bug fix**: Fixing existing behavior
- **UI change**: Styling, layout, component modifications
- **Refactor**: Code reorganization without behavioral change
- **Dependency addition**: Adding new npm packages

**If the request is ambiguous**, use AskUserQuestion to clarify (1-2 targeted questions max):
- What specific behavior should change?
- Which entities or routes are affected?
- Should this add new data or modify existing data?

**If the request is clear**, proceed immediately without questions.

## Phase 2: Plan Changes

**For simple changes** (single-file, no schema impact): skip the plan and proceed directly to Phase 3.

**For complex changes** (schema changes, multi-file features): update or create `PLAN.md` with an iteration section:

```markdown
## Iteration: [Brief Title]
_Date: [ISO date]_

### Summary
[1-2 sentences describing what changes are needed]

### Affected Files
- [ ] src/db/schema.ts — [what changes]
- [ ] src/db/zod-schemas.ts — [what changes]
- [ ] src/db/collections/[entity].ts — [what changes]
- [ ] src/routes/api/[entity].ts — [what changes]
- [ ] src/routes/[page].tsx — [what changes]
- [ ] src/components/[component].tsx — [what changes]

### Migration Required
[yes/no — only "yes" if schema.ts changes]
```

**Present the plan to the user for approval** using AskUserQuestion:
- "Here is the iteration plan. Should I proceed?"
- Options: "Approve — start building", "Revise — I have feedback"
- If "Revise": ask for feedback, update the plan, present again

## Phase 3: Execute Changes

### Read Playbooks First
Before writing code for each sub-phase, read the relevant playbook SKILL.md files:

**Available Playbooks** (read with the Read tool at these paths):

- `node_modules/@electric-sql/playbook/skills/electric-tanstack-integration/SKILL.md` — integration rules (READ FIRST for schema changes)
- `node_modules/@tanstack/db-playbook/skills/tanstack-db/SKILL.md` — collections, useLiveQuery, mutations
- `node_modules/@electric-sql/playbook/skills/electric/SKILL.md` — shape API for proxy routes

Only read playbooks relevant to your current changes.

### If Schema Changes Are Involved

Follow the Drizzle Workflow order strictly:

1. **Edit `src/db/schema.ts`** — add/modify Drizzle pgTable definitions
   - Use `ALTER TABLE` semantics (add columns, don't drop+recreate)
   - Preserve all existing tables and columns unless explicitly asked to remove
   - UUID primary keys with `defaultRandom()`
   - `timestamp({ withTimezone: true })` for all dates
   - snake_case for SQL table/column names

2. **Edit `src/db/zod-schemas.ts`** — update Zod schema derivations
   - Import `z` from `"zod/v4"` (NEVER from `"zod"`)
   - Use `createSelectSchema` and `createInsertSchema` from `drizzle-zod`
   - Override ALL timestamp columns: `z.union([z.date(), z.string()]).default(() => new Date())`
   - The `.default()` is required for `collection.insert()` to work without timestamps

3. **Run migrations**:
   ```bash
   pnpm drizzle-kit generate && pnpm drizzle-kit migrate
   ```

4. **Create/update collections** in `src/db/collections/`
   - Import select schema from `../zod-schemas`
   - Use absolute URL for `shapeOptions.url`

5. **Create/update API routes** (proxy + mutation)
   - Proxy routes use `createFileRoute` + `server.handlers`
   - Mutation routes use `parseDates(await request.json())`
   - PUT/PATCH: destructure out `created_at`, `updated_at` before spreading

6. **Create/update UI components**
   - `useLiveQuery` with `ssr: false` on leaf routes
   - `lucide-react` for icons
   - Radix UI Themes for components

### If No Schema Changes

Make changes directly to the affected files. Still follow the guardrails below.

## Phase 4: Build & Test

```bash
pnpm run build && pnpm run check
```

Fix any errors. Re-run until clean.

```bash
pnpm test
```

If tests exist and fail, fix them. If you added new entities, add schema tests:
- Import from `@/db/zod-schemas` only (NEVER from collections or `@/db`)
- Use `generateValidRow(schema)` from `tests/helpers/schema-test-utils`

## Phase 5: Update ARCHITECTURE.md

**If `ARCHITECTURE.md` exists**: update it to reflect your changes:
- Add new entities to the Data Model section
- Add new API routes to the routes table
- Add new UI routes and components
- Update the description if the app's purpose expanded

**If `ARCHITECTURE.md` doesn't exist**: create it with the standard format:
```markdown
# [App Name] — Architecture Reference
_Last updated: [ISO date]_

## App Description
[1-2 sentences]

## Data Model
### [EntityName] (`table_name`)
- **Columns**: id (uuid PK), title (text), created_at (timestamptz)
- **Relations**: [none | field -> table.id cascade]
- **Collection**: src/db/collections/[entity].ts

## API Routes
| Method | Path | File | Purpose |

## UI Routes & Components
| Route | File | Description |

### Key Components
- src/components/X.tsx — [one line: what it renders]

## Styling
- CSS files: [file: purpose]
```

## Phase 6: Start Dev Server

If schema changed: run migrations first (if not already run), then restart:
```bash
pnpm dev:restart
```

If only UI/API changed:
```bash
pnpm dev:restart
```

Verify the app starts without errors in the output.

## Critical Rules (from electric-app-guardrails)

- `z` from `"zod/v4"` — NEVER from `"zod"`
- ALL timestamp columns get `z.union([z.date(), z.string()]).default(() => new Date())`
- NEVER use `z.coerce.date()` — creates ZodEffects rejected by TanStack DB
- Mutation routes MUST use `parseDates(await request.json())`
- PUT/PATCH: destructure out `created_at`, `updated_at` before spreading
- `shapeOptions.url` MUST be absolute URL
- API routes use `createFileRoute` + `server.handlers` — NOT `createAPIFileRoute`
- Icons from `lucide-react` only
- `ssr: false` on leaf routes with `useLiveQuery`, NEVER on `__root.tsx`
- `ClientOnly` wrapper for `useLiveQuery` in `__root.tsx`
- Schema tests: import from `@/db/zod-schemas` only, NEVER from collections or `@/db`

## Protected Files — DO NOT MODIFY

- `docker-compose.yml`
- `vite.config.ts`
- `tsconfig.json`
- `biome.json`
- `pnpm-lock.yaml`
- `postgres.conf`
- `vitest.config.ts`
- `Caddyfile`
- `src/db/index.ts`
- `src/db/utils.ts`
- `src/lib/electric-proxy.ts`
- `src/components/ClientOnly.tsx`
- `tests/helpers/schema-test-utils.ts`

## Dependency Rules

- NEVER remove existing dependencies from package.json
- Only add new dependencies
