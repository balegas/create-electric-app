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
import { generateTxId } from "@/db/utils"
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

## TanStack Start Patterns

### Root Route (__root.tsx)
Use `shellComponent` (always SSR'd) and `component` (client-rendered):
```typescript
shellComponent: RootDocument,
component: () => <Outlet />,
```

### start.tsx
```typescript
createStart({ defaultSsr: false })
```

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
```typescript
export const Route = createFileRoute("/api/mutations/todos")({
  server: { handlers: { POST: async ({ request }) => {
    const data = await request.json()
    const result = await db.transaction(async (tx) => { const txid = await generateTxId(tx); const [row] = await tx.insert(todos).values(data).returning(); return { row, txid } })
    return Response.json(result)
  } } },
})
```

## Hallucination Guard

| WRONG | RIGHT |
|-------|-------|
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
