---
name: create-app
description: Create a new Electric SQL + TanStack DB application from a natural-language description. Guides through clarification, planning, data model validation, and code generation. Use this when asked to create, build, or generate a new reactive/local-first app.
argument-hint: <app description>
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Agent, WebSearch, TodoWrite
---

# Create Electric SQL App

You are building a reactive, real-time application using Electric SQL + TanStack DB + Drizzle ORM inside a scaffolded TanStack Start project.

Follow the phases below **in strict order**. Do NOT skip phases or jump ahead.

## Phase 0: Clarification

Evaluate the description provided in `$ARGUMENTS`.

**Score the description (mentally) on this scale:**
- 80-100: Very detailed — app type + specific features + data model hints
- 50-79: Recognizable app type but light on specifics
- 0-49: Too vague to proceed

**If the description scores below 70**, use AskUserQuestion to ask 1-3 targeted questions:
- What are the key features or interactions? (e.g., drag-and-drop, categories, search, due dates)
- What are the main entities/data objects and their relationships?
- Should it support multi-user collaboration with real-time sync?
- Should it work offline and sync when reconnected?

Keep questions specific to the described app type. After getting answers, enrich the description mentally and proceed.

**If the description scores 70+**, proceed immediately without questions.

## Phase 1: Generate PLAN.md

Based on the description, write a complete `PLAN.md` file with this structure:

```markdown
# [App Name] — Implementation Plan

## App Description
[1-2 sentences]

## Data Model

### [Entity Name]
\```typescript
export const entityName = pgTable("entity_name", {
  id: uuid().primaryKey().defaultRandom(),
  // ALL columns with full types, defaults, and relations
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
})
\```
(Repeat for EVERY entity)

## Implementation Tasks

### Phase 1: Data Model & Migrations
- [ ] Define all Drizzle table schemas in src/db/schema.ts
- [ ] Derive Zod schemas in src/db/zod-schemas.ts (drizzle-zod, z from "zod/v4", timestamp overrides)
- [ ] Run drizzle-kit generate && drizzle-kit migrate
- [ ] Write schema smoke tests in tests/schema.test.ts
- [ ] Run pnpm test — STOP if tests fail

### Phase 2: Collections & API Routes
- [ ] Create collection for each entity in src/db/collections/<entity>.ts
- [ ] Create Electric shape proxy route: src/routes/api/<entity>.ts
- [ ] Create mutation routes: src/routes/api/mutations/<entity>.ts

### Phase 3: UI Components
- [ ] Create page routes with useLiveQuery (ssr: false on leaf routes)
- [ ] Implement CRUD operations using mutation fetch calls
- [ ] Style with Radix UI Themes + lucide-react icons

### Phase 4: Build & Lint
- [ ] pnpm run build passes
- [ ] pnpm run check passes

### Phase 5: Testing
- [ ] Collection insert validation tests in tests/collections.test.ts
- [ ] JSON round-trip tests (parseDates + schema validation)
- [ ] pnpm test passes

### Phase 6: Architecture Reference
- [ ] Write ARCHITECTURE.md

## Design Conventions
- UUID primary keys with defaultRandom()
- timestamp({ withTimezone: true }) for all dates
- snake_case for SQL table/column names
- Foreign keys with onDelete: "cascade" where appropriate
```

**Present the plan to the user for approval** using AskUserQuestion:
- "Here is the implementation plan. Should I proceed?"
- Options: "Approve — start building", "Revise — I have feedback", "Cancel"
- If "Revise": ask for feedback, regenerate PLAN.md, present again
- If "Cancel": stop

Write the approved PLAN.md to disk.

## Phase 2: Data Model Validation (CRITICAL GATE)

This phase validates the data model BEFORE writing any application code. **Do NOT proceed to Phase 3 until tests pass.**

### Step 2a: Write Schema
Write `src/db/schema.ts` with all Drizzle pgTable definitions from PLAN.md.

Conventions:
- `uuid().primaryKey().defaultRandom()` for IDs
- `timestamp({ withTimezone: true }).notNull().defaultNow()` for timestamps
- `.references(() => table.id, { onDelete: "cascade" })` for FKs
- Do NOT import `relations` from drizzle-orm

### Step 2b: Write Zod Schemas
Write `src/db/zod-schemas.ts`:
- Import `z` from `"zod/v4"` (NOT `"zod"`)
- Use `createSelectSchema` and `createInsertSchema` from `drizzle-zod`
- Override ALL timestamp columns: `z.union([z.date(), z.string()]).default(() => new Date())`
- The `.default()` is required for `collection.insert()` to work without timestamps
- Export both select and insert schemas for each entity

### Step 2c: Run Migrations
```bash
pnpm drizzle-kit generate && pnpm drizzle-kit migrate
```

### Step 2d: Write Schema Tests
Write `tests/schema.test.ts`:
```typescript
import { generateValidRow, generateRowWithout } from "./helpers/schema-test-utils"
import { entitySelectSchema } from "@/db/zod-schemas"

describe("entity schema", () => {
  it("accepts a complete row", () => {
    expect(entitySelectSchema.safeParse(generateValidRow(entitySelectSchema)).success).toBe(true)
  })
  it("rejects without id", () => {
    expect(entitySelectSchema.safeParse(generateRowWithout(entitySelectSchema, "id")).success).toBe(false)
  })
})
```

**Rules:**
- DO NOT import collection files — they connect to Electric on import
- DO NOT import `@/db` — requires Postgres
- ONLY import from `@/db/zod-schemas` and `@/db/schema`
- Use `generateValidRow(schema)` — never hand-write test data

### Step 2e: Run Tests
```bash
pnpm test
```

**If tests fail**: fix the schema/zod-schemas and re-run. Do NOT proceed until green.
**If tests pass**: mark Phase 1 tasks as `[x]` in PLAN.md and continue.

## Phase 3: Collections & API Routes

### Collections
For each entity, create `src/db/collections/<entity>.ts`:
- Import the select schema from `@/db/zod-schemas`
- Use absolute URL for `shapeOptions.url`:
  ```typescript
  url: new URL("/api/<entity>", typeof window !== "undefined" ? window.location.origin : "http://localhost:5174").toString()
  ```

### API Routes

**Electric Shape Proxy** (`src/routes/api/<entity>.ts`):
```typescript
import { createFileRoute } from "@tanstack/react-router"
import { proxyElectricRequest } from "@/lib/electric-proxy"

export const Route = createFileRoute("/api/<entity>")({
  // @ts-expect-error – server.handlers types lag behind runtime support
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        return proxyElectricRequest(request, "<table_name>")
      },
    },
  },
})
```

**Mutation Route** (`src/routes/api/mutations/<entity>.ts`):
- Use `parseDates(await request.json())` for all handlers
- PUT/PATCH: destructure out `created_at` and `updated_at` before spreading
- Return `{ txid }` from each mutation

## Phase 4: UI Components

- Create page routes with `useLiveQuery` — add `ssr: false` to leaf routes (NOT `__root.tsx`)
- Wrap `useLiveQuery` components in `ClientOnly` when used from `__root.tsx`
- Use `lucide-react` for icons (NOT `@radix-ui/react-icons`)
- Style with Radix UI Themes components

## Phase 5: Build & Verify

Run the build tool:
```bash
pnpm run build && pnpm run check
```

Fix any errors. Re-run until clean.

## Phase 6: Final Tests

Write additional tests:
- `tests/collections.test.ts` — collection insert validation (import from zod-schemas only)
- JSON round-trip test: `parseDates(JSON.parse(JSON.stringify(row)))` validates correctly

Run `pnpm test` — fix until green.

## Phase 7: Architecture Reference

Write `ARCHITECTURE.md` in the project root (under 1500 tokens):
```markdown
# [App Name] — Architecture Reference
_Last updated: [ISO date]_

## App Description
## Data Model
### [Entity] (`table_name`)
- **Columns**: ...
- **Relations**: ...
- **Collection**: src/db/collections/...

## API Routes
| Method | Path | File | Purpose |

## UI Routes & Components
| Route | File | Description |

### Key Components

## Styling
## State & Context
```

## Critical Rules (from electric-app-guardrails)

- `z` from `"zod/v4"` — NEVER from `"zod"`
- ALL timestamp columns get `z.union([z.date(), z.string()]).default(() => new Date())`
- NEVER use `z.coerce.date()` — creates ZodEffects rejected by TanStack DB
- Mutation routes MUST use `parseDates(await request.json())`
- PUT/PATCH: destructure out `created_at`, `updated_at` before spreading
- `shapeOptions.url` MUST be absolute URL
- API routes use `createFileRoute` + `server.handlers` — NOT `createAPIFileRoute` or `createServerFileRoute`
- Icons from `lucide-react` only
- `ssr: false` on leaf routes with `useLiveQuery`, NEVER on `__root.tsx`
- `ClientOnly` wrapper for `useLiveQuery` in `__root.tsx`
- Schema tests: import from `@/db/zod-schemas` only, NEVER from collections or `@/db`

## Drizzle Workflow Order (ALWAYS follow)

1. Edit `src/db/schema.ts`
2. Edit `src/db/zod-schemas.ts` (derive via drizzle-zod)
3. `pnpm drizzle-kit generate && pnpm drizzle-kit migrate`
4. Create collections
5. Create API routes (proxy + mutation)
6. Create UI components

## Scaffold Files (DO NOT MODIFY)

- `src/db/index.ts` — Drizzle client setup
- `src/db/utils.ts` — parseDates + generateTxId
- `src/lib/electric-proxy.ts` — Electric shape proxy helper
- `src/components/ClientOnly.tsx` — SSR wrapper
- `tests/helpers/schema-test-utils.ts` — generateValidRow/generateRowWithout
- `vitest.config.ts` — test config
- `docker-compose.yml` — Postgres + Electric
- `drizzle.config.ts` — Drizzle config
