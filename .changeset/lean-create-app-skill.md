---
"@electric-agent/agent": minor
"@electric-agent/studio": minor
---

Lean create-app skill: delegate implementation details to playbook skills

The create-app skill was rewritten to be an orchestration layer rather than a prescriptive code template. Implementation details (collection setup, mutations, live queries, API routes) are now delegated to playbook skills shipped with npm dependencies (`@electric-sql/client`, `@tanstack/db`, `@tanstack/react-db`), discovered dynamically via `npx @tanstack/intent list`.

Key changes:
- Added Phase 2 "Discover & Learn" that runs `npx @tanstack/intent list` after plan approval
- Removed code templates that duplicated playbook content (52% smaller skill)
- Fixed wrong hardcoded playbook paths in CLAUDE.md (`@electric-sql/playbook/` → dynamic discovery)
- Reduced CLAUDE.md/skill duplication (drizzle workflow, SSR rules, playbook paths)
- Kept scaffold-specific gotchas not covered by playbooks (zod/v4, protected files, import rules)
- Added `scripts/setup-local-sandbox.sh` for local testing of the agent pipeline
