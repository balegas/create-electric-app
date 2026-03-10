---
"@electric-agent/studio": patch
---

Restore hardcoded playbook paths and reading order in CLAUDE.md generator.

The switch to @tanstack/intent for skill discovery removed explicit playbook paths
and reading order from the generated CLAUDE.md. Since @tanstack/intent install is
a prompt (not auto-generated), agents in sandboxes had no playbook guidance at all.
Additionally, the tanstack-db-schemas playbook uses `import { z } from 'zod'` and
`z.date().default()` which conflict with our guardrails (`zod/v4` and
`z.union([z.date(), z.string()]).default()`).

Changes:
- Restore PLAYBOOK_INSTRUCTIONS with explicit paths and reading order
- Add note that project guardrails override playbook patterns
- Include new tanstack-db sub-skills (schemas/) in the skill list
- Revert fragile mv/cat/append CLAUDE.md merge back to simple overwrite
- Restore specific Phase 1 checklist in create-app SKILL.md
