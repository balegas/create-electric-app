---
name: create-app
description: Create a new Electric SQL + TanStack DB application from a natural-language description. Guides through clarification, planning, data model validation, and code generation. Use this when asked to create, build, or generate a new reactive real-time app.
argument-hint: <app description>
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Agent, WebSearch, TodoWrite
---

# Create Electric SQL App

You are building a **reactive, real-time Electric SQL application** using:
- **Electric SQL** — Postgres-to-client sync via shapes
- **TanStack DB** — reactive collections, live queries, optimistic mutations
- **Drizzle ORM** — schema definitions and migrations
- **TanStack Start** — React meta-framework with SSR + server functions

The project is pre-scaffolded. Database and Electric sync service are provisioned. Your job is to design the data model, implement the app, and get it running.

Follow the phases below **in strict order**. Do NOT skip phases or jump ahead.

---

## Phase 0: Clarification

Evaluate the description provided in `$ARGUMENTS`.

**Score the description (mentally) on this scale:**
- 80-100: Very detailed — app type + specific features + data model hints
- 50-79: Recognizable app type but light on specifics
- 0-49: Too vague to proceed

**If the description scores below 70**, gather missing details:
- **In a room** (you have room messaging): use `@room GATE: <question>` to ask the human. The conversation pauses until they respond. Frame your question clearly — e.g., `@room GATE: Should the task manager support multiple boards or a single flat list? Also, do tasks need due dates and assignees?`
- **Solo session** (no room): use AskUserQuestion to gather missing details. You can use any combination of formats — single or multiple questions, multiSelect for picking features, headers to group topics, or free-text for open-ended input.

Choose whatever format best fits the gaps in the description. Keep questions specific to the described app type.

**If the description scores 70+**, proceed immediately.

---

## Phase 1: Plan

Write a `PLAN.md` file with this structure:

```markdown
# [App Name] — Implementation Plan

## App Description
[1-2 sentences describing a reactive, real-time Electric SQL application]

## Data Model

### [Entity Name]
- id: UUID, primary key, defaultRandom()
- [field]: [type], [constraints]
- created_at: timestamptz, notNull, defaultNow()
- updated_at: timestamptz, notNull, defaultNow()
- Relations: [FK references with onDelete cascade]

(Repeat for EVERY entity)

## Implementation Tasks
- [ ] Phase 2: Discover playbook skills and read relevant ones
- [ ] Phase 3: Data model — schema, zod-schemas, migrations, tests
- [ ] Phase 4: Collections & API routes
- [ ] Phase 5: UI components
- [ ] Phase 6: Build, lint & test
- [ ] Phase 7: README.md
- [ ] Phase 8: Deploy & send `@room REVIEW_REQUEST:` (MANDATORY — pipeline stalls without it)

## Design Conventions
- UUID primary keys with defaultRandom()
- timestamp({ withTimezone: true }) for all dates
- snake_case for SQL table/column names
- Foreign keys with onDelete: "cascade" where appropriate
```

**Write PLAN.md to disk first**, then present it for approval using AskUserQuestion:
- "I've written the implementation plan to PLAN.md. Please review it. Should I proceed?"
- Options: "Approve — start building", "Revise — I have feedback", "Cancel"
- If "Revise": ask for feedback, update PLAN.md, present again
- If "Cancel": stop

---

## Phase 2: Discover & Learn

After plan approval, discover the playbook skills installed in this project:

```bash
npx @tanstack/intent list
```

This outputs all available skills with their file paths. **Read the following skills** (use the paths from `intent list` output):

1. **`electric-new-feature`** — end-to-end Electric feature guide (schema → shapes → collections → mutations → queries). This is your primary implementation reference.
2. **`db-core/collection-setup`** — collection creation, Electric adapter, schema validation, timestamp handling
3. **`db-core/mutations-optimistic`** — insert, update, delete, optimistic actions
4. **`db-core/live-queries`** — query builder API (from, where, join, orderBy, etc.)
5. **`react-db`** — useLiveQuery, useLiveSuspenseQuery hooks
6. **`meta-framework`** — TanStack Start integration, SSR constraints, route preloading

Also read the scaffold helper files you'll use:
- `src/db/utils.ts` — `parseDates()` (JSON date round-trip) and `generateTxId()` (Electric txid handshake)
- `src/lib/electric-proxy.ts` — `proxyElectricRequest()` (Electric shape proxy for API routes)
- `tests/helpers/schema-test-utils.ts` — `generateValidRow()` / `generateRowWithout()` (test data generation)

---

## Phase 3: Data Model (CRITICAL GATE)

Validate the data model BEFORE writing application code. **Do NOT proceed until tests pass.**

### 3a: Write Drizzle Schema
Write `src/db/schema.ts` with all pgTable definitions from PLAN.md.

### 3b: Write Zod Schemas
Write `src/db/zod-schemas.ts` using `createSelectSchema` / `createInsertSchema` from `drizzle-zod`.

**Scaffold-specific gotcha — zod/v4 import:**
```typescript
import { z } from "zod/v4"  // NOT "zod" — drizzle-zod 0.8.x rejects v3 overrides
```
Playbook examples show `import { z } from "zod"` — in THIS project, always use `"zod/v4"`.

Override ALL timestamp columns — the pattern is in the `db-core/collection-setup` skill.

### 3c: Run Migrations
```bash
pnpm drizzle-kit generate && pnpm drizzle-kit migrate
```

### 3d: Write & Run Tests
Write `tests/schema.test.ts` using `generateValidRow(schema)` and `generateRowWithout(schema, field)` from `tests/helpers/schema-test-utils.ts`.

**Test rules:**
- ONLY import from `@/db/zod-schemas` and `@/db/schema`
- DO NOT import collection files (they connect to Electric on import)
- DO NOT import `@/db` (requires Postgres)
- Use `generateValidRow(schema)` — never hand-write test data

```bash
pnpm test
```

**If tests fail**: fix and re-run. Do NOT proceed until green.

---

## Phase 4: Collections & API Routes

Follow the patterns from the `electric-new-feature` and `db-core/collection-setup` skills.

**For each entity, create:**
1. **Collection** — `src/db/collections/<entity>.ts`
2. **Electric shape proxy route** — `src/routes/api/<entity>.ts` using `proxyElectricRequest()` from `src/lib/electric-proxy.ts`
3. **Mutation route** — `src/routes/api/mutations/<entity>.ts` using `parseDates()` from `src/db/utils.ts`

**Scaffold-specific patterns:**

Shape proxy routes use the scaffold helper:
```typescript
import { proxyElectricRequest } from "@/lib/electric-proxy"
// In GET handler: return proxyElectricRequest(request, "table_name")
```

Mutation routes must use `parseDates()` for JSON date round-trip:
```typescript
import { parseDates } from "@/db/utils"
// const body = parseDates(await request.json())
```

API routes use `createFileRoute` + `server.handlers` (NOT `createAPIFileRoute`).

---

## Phase 5: UI Components

**Before writing UI code**, read the ui-design skill:
- `.claude/skills/ui-design/SKILL.md` — design system, Radix UI Themes component patterns

The `__root.tsx` Theme wrapper MUST use the Electric brand defaults:
```tsx
<Theme accentColor="violet" grayColor="mauve" radius="medium" panelBackground="translucent">
```

Also read the `react-db` and `meta-framework` skills for hook usage and SSR patterns.

Key constraints:
- `ssr: false` on leaf routes that use `useLiveQuery` (NEVER on `__root.tsx`)
- All UI from `@radix-ui/themes` — never raw HTML for interactive elements
- Icons from `lucide-react` only

---

## Phase 6: Build, Lint & Test

```bash
pnpm run build && pnpm run check
```

Fix any errors. Then write additional tests:
- `tests/collections.test.ts` — collection insert validation (import from zod-schemas only)
- JSON round-trip: `parseDates(JSON.parse(JSON.stringify(row)))` validates correctly

```bash
pnpm test
```

Fix until green.

---

## Phase 7: Deploy & Send Review Request

Run migrations and start the dev server:
```bash
pnpm drizzle-kit generate && pnpm drizzle-kit migrate
pnpm dev:start
```

**IMPORTANT**: Always use `pnpm dev:start` from the project directory.

After the app is running, write:
1. `README.md` — overwrite the scaffold README with a project-specific one: app name, one-line description, screenshot placeholder, how to run (`pnpm install && pnpm dev:start`), tech stack (Electric SQL, TanStack DB, Drizzle, TanStack Start), and a brief feature list.

### Signal Completion — Send Review Request (MANDATORY)

**This is the most important step in the entire pipeline.** If you skip this, the reviewer will never start and the pipeline stalls.

After the dev server is running, you MUST send a `@room REVIEW_REQUEST:` message as the **very last thing in your response**. The message must include:
1. The repo URL
2. The branch name
3. A summary of what you built

**Exact format:**
```
@room REVIEW_REQUEST: App is live and ready for review. Repo: <url>, Branch: main. Summary: <what you built>.
```

**Do NOT** finish your response without sending this message. Do NOT assume the system will send it for you — it will not.

---

## Scaffold Gotchas (not in playbooks)

These are specific to this scaffold and NOT covered by playbook skills:

1. **`zod/v4` import** — Always `import { z } from "zod/v4"`, never `"zod"`. Playbooks show `"zod"` but drizzle-zod 0.8.x in this project requires the v4 subpath export.

2. **Protected files — DO NOT MODIFY:**
   docker-compose.yml, vite.config.ts, tsconfig.json, biome.json, pnpm-lock.yaml, postgres.conf, vitest.config.ts, Caddyfile, drizzle.config.ts, src/db/index.ts, src/db/utils.ts, src/lib/electric-proxy.ts, src/components/ClientOnly.tsx, tests/helpers/schema-test-utils.ts

3. **Import rules:**
   - `"lucide-react"` for icons (NOT @radix-ui/react-icons)
   - `"@radix-ui/themes"` for components (NOT @radix-ui/react-*)
   - `"react-router"` for routing (NOT react-router-dom)

4. **Dependency rules:**
   - NEVER remove existing dependencies from package.json
   - Only add new dependencies
