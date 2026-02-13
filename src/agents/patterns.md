# Electric App Patterns (Condensed Reference)

## Drizzle ORM Patterns

### Schema Definition (src/db/schema.ts)
```typescript
import { pgTable, uuid, text, boolean, timestamp, integer } from "drizzle-orm/pg-core"

export const todos = pgTable("todos", {
  id: uuid().primaryKey().defaultRandom(),
  text: text().notNull(),
  completed: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})
```

### Foreign Keys
Use `.references()` on the column — do NOT import `relations` from `drizzle-orm` (not used in this stack; joins happen client-side via `useLiveQuery`).
```typescript
export const comments = pgTable("comments", {
  id: uuid().primaryKey().defaultRandom(),
  todoId: uuid().notNull().references(() => todos.id, { onDelete: "cascade" }),
  body: text().notNull(),
})
```

### Zod Derivation (src/db/zod-schemas.ts)
```typescript
import { createSelectSchema, createInsertSchema } from "drizzle-zod"
import { todos } from "./schema"
export const todoSelectSchema = createSelectSchema(todos)
export const todoInsertSchema = createInsertSchema(todos)
```

### Migration Workflow
1. Edit `src/db/schema.ts`
2. Run `npx drizzle-kit generate` → creates SQL in `drizzle/`
3. Run `npx drizzle-kit migrate` → applies to Postgres

### Transaction + txid Pattern
```typescript
import { db } from "@/db"
import { todos } from "@/db/schema"
import { generateTxId, parseDates } from "@/db/utils"
const result = await db.transaction(async (tx) => {
  const txid = await generateTxId(tx)
  const [row] = await tx.insert(todos).values(data).returning()
  return { row, txid }
})
```

## Electric + TanStack DB Patterns

### Collection Definition
```typescript
import { createCollection } from "@tanstack/react-db"
import { electricCollectionOptions } from "@tanstack/electric-db-collection"
import { todoSelectSchema } from "../zod-schemas"
export const todoCollection = createCollection(
  electricCollectionOptions({
    id: "todos",
    schema: todoSelectSchema,
    getKey: (row) => row.id,
    shapeOptions: {
      url: new URL("/api/todos", typeof window !== "undefined" ? window.location.origin : "http://localhost:5173").toString(),
    },
    onInsert: async ({ transaction }) => {
      const newItem = transaction.mutations[0].modified
      const res = await fetch("/api/mutations/todos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(newItem) })
      const { txid } = await res.json()
      return { txid }
    },
  })
)
```

### Live Queries
`useLiveQuery` returns `{ data }` and the query callback uses proxy objects (NOT string paths).
```typescript
import { useLiveQuery } from "@tanstack/react-db"
import { eq } from "@tanstack/db"

// Basic query — destructure { data } from the result
const { data: todos } = useLiveQuery((q) =>
  q.from({ todos: todoCollection })
    .where(({ todos }) => eq(todos.completed, false))
    .orderBy(({ todos }) => todos.createdAt, "desc")
)

// With .select() to pick specific fields
const { data: todoItems } = useLiveQuery((q) =>
  q.from({ todos: todoCollection })
    .where(({ todos }) => eq(todos.completed, false))
    .select(({ todos }) => ({ id: todos.id, text: todos.text }))
)

// Join across collections
const { data: todosWithProject } = useLiveQuery((q) =>
  q.from({ t: todoCollection })
    .innerJoin({ p: projectCollection }, ({ t, p }) => eq(t.projectId, p.id))
    .where(({ t }) => eq(t.completed, false))
    .select(({ t, p }) => ({ id: t.id, text: t.text, projectName: p.name }))
)

// Single item lookup
const { data: todo } = useLiveQuery((q) =>
  q.from({ todos: todoCollection })
    .where(({ todos }) => eq(todos.id, someId))
    .findOne()
)
```
**CRITICAL**: Do NOT call `.toArray()` — it does not exist. Just return the query chain.
**CRITICAL**: `.where()` and `.orderBy()` take callbacks that destructure the collection aliases — do NOT pass string field paths.

### Client-Side Mutations (CRITICAL)
When calling `collection.insert()`, you MUST provide ALL fields including `id` and timestamps.
The collection schema validates data client-side BEFORE any server call — Postgres defaults do NOT apply.
```typescript
// INSERT — provide ALL fields, generate id and timestamps client-side
todoCollection.insert({
  id: crypto.randomUUID(),
  text: "Buy groceries",
  completed: false,
  projectId: projectId,
  position: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
})

// UPDATE — pass the id and a callback that mutates the draft
todoCollection.update(todoId, (draft) => {
  draft.completed = !draft.completed
  draft.updatedAt = new Date()
})

// DELETE — pass the id
todoCollection.delete(todoId)
```
**CRITICAL**: Never omit `id`, `createdAt`, or `updatedAt` from inserts — they are validated by the Zod selectSchema and will throw `SchemaValidationError` if missing.

## TanStack Start Patterns

### SSR Configuration (CRITICAL)
The **root route** (`__root.tsx`) must ALWAYS have SSR enabled (the default). It renders the HTML shell (`<html>`, `<head>`, `<Scripts>`). If you add `ssr: false` to the root, the HTML document won't render and the page will be blank.

Instead, add `ssr: false` to each **leaf route** that uses `useLiveQuery` or TanStack DB collections:
```typescript
export const Route = createFileRoute("/")({
  ssr: false,  // Disable SSR on this route — it uses useLiveQuery
  component: HomePage,
})
```
This is needed because `useLiveQuery` uses `useSyncExternalStore` without `getServerSnapshot`.

**NEVER add `ssr: false` to `__root.tsx`** — it breaks the entire app.

### Components with useLiveQuery in __root.tsx (CRITICAL)
If a component uses `useLiveQuery` (e.g. a Sidebar) and must be rendered from `__root.tsx`, wrap it with `ClientOnly` to prevent SSR crashes:
```typescript
import { ClientOnly } from "../components/ClientOnly"
import { Sidebar } from "../components/Sidebar"

// In RootComponent:
<ClientOnly fallback={<Box style={{ width: 240 }} />}>
  {() => <Sidebar />}
</ClientOnly>
```
`ClientOnly` is provided by the scaffold. It uses `useSyncExternalStore` with `getServerSnapshot=false` to skip SSR cleanly without hydration mismatch.

**NEVER render a component that uses `useLiveQuery` or collections directly in `__root.tsx` without `ClientOnly`** — it will crash with `Missing getServerSnapshot`.

### Route Naming Convention
- `/api/<tablename>` — Electric shape proxy (GET only)
- `/api/mutations/<tablename>` — Write mutations (POST/PUT/DELETE)

### Proxy Route Pattern
```typescript
import { proxyElectricRequest } from "../../lib/electric-proxy"
export const Route = createFileRoute("/api/todos")({
  server: { handlers: { GET: async ({ request }) => proxyElectricRequest(request, "todos") } },
})
```

### Mutation Route Pattern
**CRITICAL**: Always wrap `request.json()` with `parseDates()` — JSON serialization turns `Date` objects into ISO strings, and Drizzle's timestamp columns crash on strings.
```typescript
import { parseDates } from "@/db/utils"
export const Route = createFileRoute("/api/mutations/todos")({
  server: { handlers: { POST: async ({ request }) => {
    const data = parseDates(await request.json())
    const result = await db.transaction(async (tx) => { const txid = await generateTxId(tx); const [row] = await tx.insert(todos).values(data).returning(); return { row, txid } })
    return Response.json(result)
  } } },
})
```

## Icons
Use `lucide-react` for all icons — it is already installed. Do NOT use `@radix-ui/react-icons` (not installed).
```typescript
import { Trash2, Plus, ArrowLeft, Check, X, Search, Settings } from "lucide-react"
```
Lucide icons render as SVG at the current font size by default. Use the `size` prop if you need a specific pixel size:
```tsx
<IconButton variant="ghost" color="red"><Trash2 size={16} /></IconButton>
```

## Testing Patterns

### Test File Structure
```
tests/
├── helpers/
│   └── schema-test-utils.ts    # generateValidRow, generateRowWithout (provided by scaffold)
├── schema.test.ts              # Zod schema smoke tests — no Docker needed
├── collections.test.ts         # Collection insert validation — no Docker needed
└── integration/
    └── data-flow.test.ts       # Drizzle insert + read back — requires Docker
```

### Schema Smoke Test (tests/schema.test.ts)
Validates that Zod selectSchemas accept complete rows (as TanStack DB collections would).
```typescript
import { describe, it, expect } from "vitest"
import { generateValidRow, generateRowWithout } from "./helpers/schema-test-utils"
import { todoSelectSchema } from "@/db/zod-schemas"

describe("todo schema", () => {
  it("accepts a complete row", () => {
    const row = generateValidRow(todoSelectSchema)
    const result = todoSelectSchema.safeParse(row)
    expect(result.success).toBe(true)
  })

  it("rejects a row without id", () => {
    const row = generateRowWithout(todoSelectSchema, "id")
    const result = todoSelectSchema.safeParse(row)
    expect(result.success).toBe(false)
  })

  it("rejects a row without createdAt", () => {
    const row = generateRowWithout(todoSelectSchema, "createdAt")
    const result = todoSelectSchema.safeParse(row)
    expect(result.success).toBe(false)
  })
})
```
Repeat the describe block for EVERY entity's selectSchema.

### Collection Insert Validation Test (tests/collections.test.ts)
Simulates what `collection.insert()` does: validate with the selectSchema BEFORE sending to server.
```typescript
import { describe, it, expect } from "vitest"
import { generateValidRow } from "./helpers/schema-test-utils"
import { todoSelectSchema } from "@/db/zod-schemas"

describe("todo collection insert validation", () => {
  it("validates a complete insert payload", () => {
    const row = generateValidRow(todoSelectSchema)
    // This is exactly what collection.insert() does client-side
    const result = todoSelectSchema.safeParse(row)
    expect(result.success).toBe(true)
  })

  it("has all required fields for client-side insert", () => {
    // Verify the schema shape includes id and timestamps
    const shape = todoSelectSchema.shape
    expect(shape).toHaveProperty("id")
    expect(shape).toHaveProperty("createdAt")
  })
})
```

### Integration Test (tests/integration/data-flow.test.ts)
Inserts via Drizzle → reads back → parses with Zod. Requires Docker (Postgres running).
```typescript
import { describe, it, expect } from "vitest"
import { db } from "@/db"
import { todos } from "@/db/schema"
import { todoSelectSchema } from "@/db/zod-schemas"

describe("todo data flow", () => {
  it("inserts and reads back a valid row", async () => {
    const [row] = await db.insert(todos).values({ text: "test" }).returning()
    const result = todoSelectSchema.safeParse(row)
    expect(result.success).toBe(true)
  })
})
```

### JSON Round-Trip Test (tests/collections.test.ts)
Simulates the actual mutation path: `Date` → `JSON.stringify` → string → must survive Drizzle insert.
```typescript
it("survives JSON round-trip (Date → string → Date)", () => {
  const row = generateValidRow(todoSelectSchema)
  // Simulate what fetch() does: serialize to JSON and back
  const serialized = JSON.parse(JSON.stringify(row))
  // parseDates is what mutation routes must call
  const revived = parseDates(serialized)
  const result = todoSelectSchema.safeParse(revived)
  expect(result.success).toBe(true)
})
```
This test catches the #1 runtime bug: `toISOString is not a function` when mutation routes forget `parseDates()`.

### Testing Critical Rules
- **DO NOT** import collection files in smoke tests — collections connect to Electric on import
- **DO NOT** import `@/db` (Drizzle client) in smoke tests — it requires a Postgres connection
- **ONLY** import from `@/db/zod-schemas` and `@/db/schema` in smoke tests
- **ALWAYS** test that removing `id`, `createdAt`, and `updatedAt` causes validation to fail
- Smoke tests MUST work without Docker — they only validate Zod schemas in memory

## Hallucination Guard

| WRONG | RIGHT |
|-------|-------|
| `collection.insert({ name: "foo" })` (partial) | Always provide ALL fields: `{ id: crypto.randomUUID(), name: "foo", createdAt: new Date(), updatedAt: new Date() }` |
| `import { X } from '@radix-ui/react-icons'` | `from 'lucide-react'` (e.g. `import { Trash2, ArrowLeft } from "lucide-react"`) |
| `import { useQuery } from '@tanstack/react-db'` | `useLiveQuery` |
| `import { electricCollectionOptions } from '@tanstack/react-db'` | `from '@tanstack/electric-db-collection'` |
| `import { createInsertSchema } from 'drizzle-orm/zod'` | `from 'drizzle-zod'` (drizzle-orm/zod not available in 0.45.x) |
| `createCollection({ ...electricCollectionOptions() })` | `createCollection(electricCollectionOptions({}))` (no spread) |
| `import { drizzle } from 'drizzle-orm'` | `from 'drizzle-orm/postgres-js'` |
| `.toArray()` on query builder | Remove — just return the chain from the callback |
| `const todos = useLiveQuery(...)` | `const { data: todos } = useLiveQuery(...)` (returns `{ data }`) |
| `.where(eq("todos.field", val))` | `.where(({ todos }) => eq(todos.field, val))` (callback with proxy) |
| `.orderBy("todos.field", "asc")` | `.orderBy(({ todos }) => todos.field, "asc")` (callback with proxy) |
| `import { eq } from '@tanstack/react-db'` | Both `@tanstack/react-db` and `@tanstack/db` work; prefer `@tanstack/db` for filter-only imports |
| `ssr: false` on `__root.tsx` | NEVER — root must SSR (it renders the HTML shell). Add `ssr: false` to leaf routes instead |
| `ssr: true` on a leaf route using `useLiveQuery` | Add `ssr: false` to that leaf route |
| `<Sidebar />` (useLiveQuery) directly in `__root.tsx` | Wrap with `<ClientOnly>{() => <Sidebar />}</ClientOnly>` — SSR will crash without it |
| `import { relations } from "drizzle-orm"` | NOT used — define FKs with `.references()` on the column. Joins happen client-side via `useLiveQuery` |
| `import { todoCollection } from ...` in smoke tests | NEVER — collections connect to Electric on import. Import from `@/db/zod-schemas` only |
| `import { db } from "@/db"` in smoke tests | NEVER — requires Postgres. Only in integration tests |
| Testing with partial fields `{ text: "foo" }` | Always use `generateValidRow(schema)` to get ALL fields |
| `const data = await request.json()` then `db.insert().values(data)` | ALWAYS use `parseDates(await request.json())` — JSON turns Dates into strings, Drizzle crashes |

## vite.config.ts
Must include `nitro()` plugin for server routes:
```typescript
import { nitro } from "nitro/vite"
plugins: [nitro(), tanstackStart(), viteReact()]
```

## Key Requirements
- `src/server.ts` entry point required
- UUID primary keys with `defaultRandom()`
- `timestamp({ withTimezone: true })` for all date columns
- snake_case for table/column names, camelCase for TypeScript
- Every table needs REPLICA IDENTITY FULL (auto-applied by migration hook)
