# RFC v4.0 → v4.1 Changes

Changes needed to the RFC based on implementation plan research and review.

---

## 1. Replace dbmate with Drizzle ORM

**RFC Section 4 (Generated Code Structure)** and **Section 5 (Core Generation)**

The RFC specifies dbmate for migrations and hand-written Zod schemas. Replace with Drizzle ORM as the single source of truth:

```
Before (RFC v4.0):
  dbmate migrations (hand-written SQL)
  + hand-written Zod schemas
  + manual sync between SQL and Zod

After (RFC v4.1):
  Drizzle pgTable() definitions (TypeScript)
  → drizzle-kit generate (auto SQL migrations)
  → drizzle-orm/zod createSelectSchema() (auto Zod schemas)
  → collections use derived schemas
```

**Changes:**
- Replace `dbmate` references with `drizzle-kit` throughout
- Replace `db/migrations/*.sql` with `drizzle/*.sql` (auto-generated)
- Replace hand-written `schemas/*.ts` with `db/zod-schemas.ts` using `createSelectSchema()`
- Add `drizzle.config.ts` to template file list
- Update dependency table: add `drizzle-orm`, `drizzle-kit`, `postgres`; remove `dbmate`
- Add `drizzle-orm/postgres-js` for DB connection
- Update generated code structure diagram

---

## 2. Replace `drizzle-zod` with `drizzle-orm/zod`

**RFC Section 4 (hallucination table)**

The `drizzle-zod` package is deprecated since drizzle-orm 0.44.0. The Zod integration is now built into drizzle-orm.

**Changes:**
- Add to hallucination table: `import from 'drizzle-zod'` → `import from 'drizzle-orm/zod'`
- Update all schema derivation examples to use `drizzle-orm/zod`

---

## 3. Agent SDK architecture update

**RFC Section 3 (System Architecture)**

The RFC architecture diagram shows custom components that the Agent SDK provides for free. Simplify:

**Changes:**
- Remove "Tool Registry" from custom code — Agent SDK has built-in tool dispatch
- Remove "Agentic Loop" from custom code — Agent SDK's `query()` provides this
- Add "Agent SDK query()" as the core execution engine in the architecture diagram
- Clarify that built-in tools (Read, Write, Edit, Glob, Grep, Bash, Task) come from the SDK
- Add `permissionMode: "bypassPermissions"` to agent configuration examples
- Add `maxBudgetUsd` and `maxTurns` parameters
- Note: Sub-agent orchestration uses SDK's `Task` tool, not custom implementation

---

## 4. Clarify route naming convention

**RFC Section 4 (Generated Code Structure) and Section 5 (Proxy Routes)**

The RFC mentions "proxy routes" but doesn't distinguish read-path from write-path clearly.

**Changes:**
- Define convention:
  - `/api/<tablename>` — Electric shape proxy (GET only, forwards to Electric)
  - `/api/mutations/<tablename>` — Write mutations (POST/PUT/DELETE, uses Drizzle to write to Postgres)
- Update route examples to follow this convention
- Update generated code structure to show both route types

---

## 5. Migration validation hook redesign

**RFC Section 8 (Guardrails)**

The RFC's "collection-schema validation" guardrail was designed for hand-written SQL + hand-written Zod. With Drizzle, the guardrail changes:

**Changes:**
- Replace "collection-schema validation" with "migration validation":
  - Triggers on `drizzle-kit migrate` or `drizzle-kit push` Bash commands
  - Scans generated SQL files for `CREATE TABLE` statements
  - Auto-appends `ALTER TABLE ... REPLICA IDENTITY FULL` using direct `fs.appendFileSync()` (hooks run in Node.js process, not via agent tools)
  - Then allows the migrate command to proceed
- Add "schema-consistency" PostToolUse hook:
  - Checks that collection files import schemas from `drizzle-orm/zod` derivation, not hand-written Zod
  - Returns warning via `additionalContext` if violation detected
- Update guardrail count: still 5 guardrails, but the migration one works differently

---

## 6. Add vite.config.ts nitro requirement to scaffolding

**RFC Section 4 (Template) and Section 5 (Scaffolding)**

The RFC's template setup doesn't mention the `nitro()` Vite plugin, which is required for server routes (proxy + mutation routes).

**Changes:**
- Add to scaffolding steps: "Modify `vite.config.ts` to add `nitro()` plugin"
- Add `nitro` to the dependency table
- Example:
  ```typescript
  // vite.config.ts
  import { nitro } from 'nitro/vite'
  export default defineConfig({
    plugins: [nitro(), tanstackStart(), viteReact()],
  })
  ```

---

## 7. Add Caddy trust step to `electric-agent up`

**RFC Section 7 (CLI Commands)**

The `electric-agent up` command starts Caddy for HTTP/2 but doesn't handle certificate trust. First-time users will get browser security warnings.

**Changes:**
- Add step between Docker startup and migration: "Trust Caddy's local CA if not already trusted"
- Implementation: check if `caddy trust` is available and run it, or print instructions for manual trust

---

## 8. Reorder phases: Working Memory before Agent Orchestration

**RFC Section 10 (Implementation Phases)**

Working memory (`_agent/errors.md`, `_agent/session.md`) is a dependency for the coder's error handling and retry logic. It should be implemented before the agent orchestration layer that consumes it.

**Changes:**
- Move "Working Memory & Session" from Phase 8 to Phase 4
- Renumber subsequent phases:
  - Phase 4: Working Memory & Session (was Phase 8)
  - Phase 5: Patterns File & System Prompts (was Phase 4)
  - Phase 6: Agent Orchestration (was Phase 5)
  - Phase 7: CLI Commands (was Phase 6)
  - Phase 8: Generated Documentation (was Phase 7)
  - Phase 9: Integration Testing (unchanged)

---

## 9. Gitignore correction: commit migration SQL files

**RFC Section 4 (Generated Code Structure)**

The RFC implies `drizzle/` should be gitignored. Only the internal snapshots should be ignored; the SQL migration files are valuable artifacts.

**Changes:**
- `.gitignore` should include `drizzle/meta/` (internal drizzle-kit snapshots), NOT `drizzle/`
- The `drizzle/*.sql` files should be committed — they're the migration history
- Update any references to gitignore patterns

---

## Summary

These changes reflect three categories of improvement:

1. **Drizzle integration** (#1, #2, #5, #9) — single source of truth for the data model
2. **Agent SDK alignment** (#3, #8) — leverage SDK capabilities, correct dependency ordering
3. **Missing infrastructure** (#4, #6, #7) — gaps discovered during playbook research
