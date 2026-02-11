// Zod schemas derived from Drizzle tables.
// Never hand-write Zod schemas — always use createSelectSchema / createInsertSchema.
//
// Example:
// import { createSelectSchema, createInsertSchema } from "drizzle-orm/zod"
// import { todos } from "./schema"
//
// export const todoSelectSchema = createSelectSchema(todos)
// export const todoInsertSchema = createInsertSchema(todos)
//
// export type Todo = typeof todoSelectSchema._type
// export type NewTodo = typeof todoInsertSchema._type

export {}
