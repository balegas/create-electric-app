---
name: electric-app-guardrails
description: Project-specific guardrails for drizzle-zod integration, parseDates, ClientOnly, testing patterns, and hallucination guard. Read this FIRST before coding.
triggers:
  - zod-schemas
  - drizzle-zod
  - parseDates
  - ClientOnly
  - testing
  - smoke test
  - hallucination
  - lucide
  - icons
---

# Project-Specific Guardrails

Patterns NOT covered by external playbooks. Read playbooks for collections, live-queries, mutations, schemas, and Electric quickstart patterns.

## Drizzle-Zod Integration (CRITICAL)

**Import `z` from `"zod/v4"`** (NOT `"zod"`) — drizzle-zod 0.8.x peer-depends on zod >=3.25 which exports v4 as a subpath. The `createSelectSchema` function rejects v3-style overrides with "Invalid element: expected a Zod schema".

**Always override timestamp columns** using the TanStack DB pattern from `tanstack-db/collections/SKILL.md`:

```typescript
// src/db/zod-schemas.ts
import { createSelectSchema, createInsertSchema } from "drizzle-zod"
import { z } from "zod/v4"
import { todos } from "./schema"

const dateField = z
  .union([z.string(), z.date()])
  .transform((val) => (typeof val === 'string' ? new Date(val) : val))
  .default(() => new Date())

export const todoSelectSchema = createSelectSchema(todos, {
  created_at: dateField,
  updated_at: dateField,
})
export const todoInsertSchema = createInsertSchema(todos, {
  created_at: dateField.optional(),
  updated_at: dateField.optional(),
})
```

This pattern:
- Accepts both strings (from Electric sync) and Dates (from local code)
- Transforms strings to Date objects (proper typing, TInput ⊇ TOutput)
- Defaults timestamps for `collection.insert()` without explicit values
- Works with `collection.update()` round-trips (Date passes back through union)

**Use `selectSchema` as the collection schema** — it has defaults for timestamps so `collection.insert()` works without them, and validates fully populated rows from Electric sync.

## parseDates Utility (CRITICAL)

Mutation routes MUST wrap `request.json()` with `parseDates()` — JSON serialization turns Date objects into ISO strings, and Drizzle's timestamp columns crash on strings.
```typescript
import { parseDates } from "@/db/utils"
const data = parseDates(await request.json())
```

## Mutation PUT/PATCH Handlers (CRITICAL)

**Always destructure out timestamp columns** before spreading into `.set()`. Electric streams timestamps as Postgres-format strings (`"2024-01-01 00:00:00+00"` — space separator, not ISO `T`). `parseDates` only matches ISO format, so these pass through as raw strings. Drizzle's `PgTimestamp.mapToDriverValue` calls `.toISOString()` on them → `TypeError: value.toISOString is not a function`.

```typescript
// WRONG — created_at leaks into .set() as a string, Drizzle crashes
const { id, ...rest } = body
await tx.update(todos).set({ ...rest, updated_at: new Date() })

// RIGHT — strip timestamps, only spread user-editable fields
const { id, created_at: _, updated_at: __, ...fields } = body
await tx.update(todos).set({ ...fields, updated_at: new Date() })
```

## ClientOnly Wrapper

Components using `useLiveQuery` that must render from `__root.tsx` need `ClientOnly`:
```typescript
import { ClientOnly } from "../components/ClientOnly"
<ClientOnly fallback={<Box style={{ width: 240 }} />}>
  {() => <Sidebar />}
</ClientOnly>
```
`ClientOnly` is provided by the scaffold. **NEVER render useLiveQuery components directly in `__root.tsx`** — crashes with `Missing getServerSnapshot`.

## Collection shapeOptions URL (CRITICAL)

`shapeOptions.url` MUST be an absolute URL — Electric's `ShapeStream` calls `new URL(url)` with no base, which throws on relative paths like `"/api/todos"`.

```typescript
// WRONG — relative URL, ShapeStream throws "Invalid URL"
shapeOptions: { url: "/api/todos" }

// RIGHT — absolute URL with SSR-safe fallback
shapeOptions: {
  url: new URL(
    "/api/todos",
    typeof window !== "undefined" ? window.location.origin : "http://localhost:5174",
  ).toString(),
}
```

## API Route Pattern (CRITICAL)

Use `createFileRoute` from `@tanstack/react-router` with `server.handlers`. Do NOT use `createAPIFileRoute` or `createServerFileRoute` — those do not exist in the installed packages.

### Electric Shape Proxy Route (`src/routes/api/<tablename>.ts`)
```typescript
import { createFileRoute } from "@tanstack/react-router"
import { proxyElectricRequest } from "@/lib/electric-proxy"

export const Route = createFileRoute("/api/todos")({
  // @ts-expect-error – server.handlers types lag behind runtime support
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        return proxyElectricRequest(request, "todos")
      },
    },
  },
})
```

### Mutation Route (`src/routes/api/mutations/<tablename>.ts`)
```typescript
import { createFileRoute } from "@tanstack/react-router"
import { eq } from "drizzle-orm"
import { db } from "@/db"
import { todos } from "@/db/schema"
import { generateTxId, parseDates } from "@/db/utils"

export const Route = createFileRoute("/api/mutations/todos")({
  // @ts-expect-error – server.handlers types lag behind runtime support
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const body = parseDates(await request.json())
        const txid = await db.transaction(async (tx) => {
          await tx.insert(todos).values(body)
          return generateTxId(tx)
        })
        return new Response(JSON.stringify({ txid }), {
          headers: { "Content-Type": "application/json" },
        })
      },
      PUT: async ({ request }: { request: Request }) => {
        const body = parseDates(await request.json())
        const { id, created_at: _, updated_at: __, ...fields } = body
        const txid = await db.transaction(async (tx) => {
          await tx.update(todos).set({ ...fields, updated_at: new Date() }).where(eq(todos.id, id as string))
          return generateTxId(tx)
        })
        return new Response(JSON.stringify({ txid }), {
          headers: { "Content-Type": "application/json" },
        })
      },
      DELETE: async ({ request }: { request: Request }) => {
        const body = parseDates(await request.json())
        const txid = await db.transaction(async (tx) => {
          await tx.delete(todos).where(eq(todos.id, body.id as string))
          return generateTxId(tx)
        })
        return new Response(JSON.stringify({ txid }), {
          headers: { "Content-Type": "application/json" },
        })
      },
    },
  },
})
```

### Route Naming Convention

- `/api/<tablename>` — Electric shape proxy (GET only)
- `/api/mutations/<tablename>` — Write mutations (POST/PUT/DELETE)

## Icons

Use `lucide-react` (already installed). Do NOT use `@radix-ui/react-icons` (not installed).
```typescript
import { Trash2, Plus, Check, X, Search } from "lucide-react"
```

## Drizzle Schema Conventions

- UUID primary keys: `uuid().primaryKey().defaultRandom()`
- Timestamps: `timestamp({ withTimezone: true })`
- snake_case for SQL table/column names
- Foreign keys: `.references(() => table.id, { onDelete: "cascade" })` — do NOT import `relations` from `drizzle-orm`
- Every table needs REPLICA IDENTITY FULL (auto-applied by migration hook)
- `src/server.ts` entry point is required
- vite.config.ts must include `nitro()` plugin

## Testing Patterns

### File Structure
```
tests/
├── helpers/
│   └── schema-test-utils.ts    # generateValidRow, generateRowWithout (scaffold-provided)
├── schema.test.ts              # Zod schema smoke tests — no Docker
├── collections.test.ts         # Collection insert validation — no Docker
└── integration/
    └── data-flow.test.ts       # Drizzle insert + read back — requires Docker
```

### Schema Smoke Test
```typescript
import { generateValidRow, generateRowWithout } from "./helpers/schema-test-utils"
import { todoSelectSchema } from "@/db/zod-schemas"

describe("todo schema", () => {
  it("accepts a complete row", () => {
    expect(todoSelectSchema.safeParse(generateValidRow(todoSelectSchema)).success).toBe(true)
  })
  it("rejects without id", () => {
    expect(todoSelectSchema.safeParse(generateRowWithout(todoSelectSchema, "id")).success).toBe(false)
  })
})
```

### JSON Round-Trip Test
```typescript
it("survives JSON round-trip", () => {
  const row = generateValidRow(todoSelectSchema)
  const serialized = JSON.parse(JSON.stringify(row))
  const revived = parseDates(serialized)
  expect(todoSelectSchema.safeParse(revived).success).toBe(true)
})
```

### Testing Rules
- **DO NOT** import collection files in smoke tests — collections connect to Electric on import
- **DO NOT** import `@/db` in smoke tests — requires Postgres
- **ONLY** import from `@/db/zod-schemas` and `@/db/schema` in smoke tests
- **ALWAYS** test that removing `id`, `createdAt`, `updatedAt` causes validation failure
- Use `generateValidRow(schema)` — never hand-write partial test data

## Hallucination Guard

| WRONG | RIGHT |
|-------|-------|
| `import { z } from "zod"` in zod-schemas | `import { z } from "zod/v4"` — drizzle-zod 0.8.x rejects v3 overrides |
| `createSelectSchema(todos)` without date overrides | Override ALL timestamps with `z.union([z.string(), z.date()]).transform(...).default(...)` |
| `z.date().default(() => new Date())` for timestamps | `z.union([z.string(), z.date()]).transform(val => typeof val === 'string' ? new Date(val) : val).default(() => new Date())` — Electric streams dates as strings |
| `import { createInsertSchema } from 'drizzle-orm/zod'` | `from 'drizzle-zod'` |
| `import { drizzle } from 'drizzle-orm'` | `from 'drizzle-orm/postgres-js'` |
| `import { X } from '@radix-ui/react-icons'` | `from 'lucide-react'` |
| `import { relations } from "drizzle-orm"` | Use `.references()` on columns instead |
| `const data = await request.json()` in mutations | `parseDates(await request.json())` |
| `<Sidebar />` (useLiveQuery) in `__root.tsx` | `<ClientOnly>{() => <Sidebar />}</ClientOnly>` |
| `import { todoCollection }` in smoke tests | Import from `@/db/zod-schemas` only |
| `import { db } from "@/db"` in smoke tests | Only in integration tests |
| Testing with `{ text: "foo" }` (partial) | `generateValidRow(schema)` |
| `const { id, ...rest } = body` then `.set(rest)` in PUT | Destructure out `created_at`, `updated_at` before spreading |
| `shapeOptions: { url: "/api/todos" }` (relative) | `url: new URL("/api/todos", typeof window !== "undefined" ? window.location.origin : "http://localhost:5174").toString()` |
| `import { createAPIFileRoute } from '@tanstack/start/api'` | Does NOT exist — use `createFileRoute` from `@tanstack/react-router` with `server.handlers` |
| `import { createServerFileRoute } from '@tanstack/start/server'` | Does NOT exist — use `createFileRoute` from `@tanstack/react-router` with `server.handlers` |
| `createAPIFileRoute('/api/todos')` | `createFileRoute('/api/todos')({ server: { handlers: { GET: ... } } })` |
