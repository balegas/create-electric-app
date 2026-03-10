---
"@electric-agent/agent": patch
"@electric-agent/studio": patch
---

Align guardrails with TanStack playbooks and restore skill discovery.

- Adopt TanStack's `z.union([z.string(), z.date()]).transform().default()` timestamp
  pattern (from tanstack-db/collections/SKILL.md) — strictly better than our old
  `z.union([z.date(), z.string()]).default()` because it converts strings to Dates
- Remove stale `z.coerce.date()` ban — works correctly with zod >=3.25
- Bump zod from `^3.24` to `^3.25` to satisfy drizzle-zod 0.8.x peer dep
- Add all TanStack DB sub-skills (collections, schemas, mutations, live-queries,
  electric) to playbook listing with updated reading order
- Integrate `npx @tanstack/intent list` into create-app Phase 1 for dynamic
  skill discovery
- Keep `zod/v4` import requirement (verified: drizzle-zod rejects v3 overrides)
- Revert fragile mv/cat/append CLAUDE.md merge back to simple overwrite
