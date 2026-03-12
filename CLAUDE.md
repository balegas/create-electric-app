# create-electric-app

## Project Context
This is a reactive, real-time application built with Electric SQL + TanStack DB + Drizzle ORM + TanStack Start.

## Sandbox Environment (IMPORTANT — READ FIRST)
You are running inside a cloud micro-VM (Fly.io Sprite). This is NOT a local machine.

### Networking & Port Exposure
- The Sprite HTTP proxy routes all external traffic to **port 8080** inside the VM
- Your app MUST listen on port 8080 to be accessible via the preview URL — this is pre-configured via the `VITE_PORT` environment variable
- The app MUST bind to `0.0.0.0` (not localhost) — pre-configured via `host: true` in vite.config.ts
- The preview URL follows the pattern: `https://<sprite-name>.sprites.app`
- There is NO way to expose other ports — only port 8080 is proxied

### What's Available
- Node.js (via nvm at `/.sprite/languages/node/nvm/`)
- pnpm, git, gh CLI
- Outbound internet access (npm install, API calls, etc.)
- `DATABASE_URL` — remote Postgres (Neon), no local database

### What's NOT Available
- Docker, docker-compose, or any container runtime
- Local Postgres or any local database
- Ports other than 8080 for external HTTP access

### PATH
- npm global binaries are NOT in PATH by default
- If you need a globally installed tool, source the profile first: `source /etc/profile.d/npm-global.sh`

## Lint & Formatting (REQUIRED before every commit)

Run `pnpm check:fix` before every commit to fix formatting and lint issues. CI runs `pnpm check` and will fail if code is not formatted correctly (biome enforces tabs, double quotes, no semicolons, organized imports, and lint rules).

## Changesets (REQUIRED before every commit)

This is a pnpm monorepo with three packages: `@electric-agent/agent`, `@electric-agent/studio`, `@electric-agent/protocol`.

Before committing any change, create a changeset for each affected package:

```bash
# Create a new changeset file manually in .changeset/<short-description>.md
# Format:
---
"@electric-agent/studio": patch   # or minor / major
---

Short description of what changed and why.
```

- Use `patch` for bug fixes, `minor` for new features, `major` for breaking changes.
- Only list packages that were actually modified.
- The file name should be a short kebab-case description of the change.

## Current Task
Resumed from https://github.com/balegas/create-electric-app

## App Generation Pipeline (CRITICAL)
When building a new app, you MUST use the /create-app skill. This skill is available at .claude/skills/create-app/SKILL.md and provides the structured phased pipeline for generating Electric SQL apps.

Invoke it with: /create-app <description>

The skill enforces the correct phase order:
1. Clarification (if description is vague)
2. Plan generation (PLAN.md with data model + tasks)
3. Data model validation (schema + zod-schemas + tests — STOP if tests fail)
4. Collections & API routes
5. UI components
6. Build & lint
7. Final tests
8. Architecture reference (ARCHITECTURE.md)

Do NOT skip phases or code ad-hoc. Always follow the skill's structured pipeline.

## Scaffold Structure (DO NOT EXPLORE)
The project is scaffolded from a known template. DO NOT read or explore scaffold files before coding. You already know the structure:
- src/db/schema.ts — placeholder Drizzle schema (you will overwrite)
- src/db/zod-schemas.ts — placeholder Zod derivation (you will overwrite)
- src/db/index.ts — Drizzle client setup (do not modify)
- src/db/utils.ts — parseDates + generateTxId helpers (do not modify)
- src/lib/electric-proxy.ts — Electric shape proxy helper (do not modify)
- src/components/ClientOnly.tsx — SSR wrapper (do not modify, just import when needed)
- src/routes/__root.tsx — root layout with SSR (do not add ssr:false here)
- tests/helpers/schema-test-utils.ts — generateValidRow/generateRowWithout (do not modify)

DO NOT use Bash/ls/find to explore the project. DO NOT read files you aren't about to modify. Start writing code.

## Drizzle Workflow (CRITICAL)
Always follow this order:
1. Edit src/db/schema.ts (Drizzle pgTable definitions)
2. Edit src/db/zod-schemas.ts (derive Zod schemas via createSelectSchema/createInsertSchema from drizzle-zod — NEVER hand-write Zod schemas — ALWAYS import z from "zod/v4" and override ALL timestamp columns — see playbook tanstack-db/collections/SKILL.md for the correct pattern)
3. Create collection files in src/db/collections/ (import from ../zod-schemas)
4. Create API routes (proxy + mutation)
5. Create UI components

## Guardrails (MUST FOLLOW)

### Protected Files — DO NOT MODIFY
- docker-compose.yml
- vite.config.ts (pre-configured with port, host, allowedHosts, and proxy — modifying it WILL break the preview)
- tsconfig.json
- biome.json
- pnpm-lock.yaml
- postgres.conf
- vitest.config.ts
- Caddyfile

### Import Rules
- Use "zod/v4" (NOT "zod") for all Zod imports
- Use "lucide-react" for icons (NOT @radix-ui/react-icons)
- Use "@radix-ui/themes" for Radix components (NOT @radix-ui/react-*)
- Use "react-router" for routing (NOT react-router-dom)

### Dependency Rules
- NEVER remove existing dependencies from package.json
- Only add new dependencies

### Schema Rules
- ALL timestamp columns MUST be overridden — use the union+transform+default pattern from tanstack-db/collections/SKILL.md
- ALL tables MUST have REPLICA IDENTITY FULL (auto-applied by migration hook)
- UUID primary keys with defaultRandom()
- timestamp({ withTimezone: true }) for all dates
- snake_case for SQL table/column names
- Foreign keys with onDelete: "cascade" where appropriate

## Playbooks (Domain Knowledge — MUST READ)
Playbook SKILL.md files contain critical API usage patterns. Read them BEFORE writing code for each phase.

### Available Skills
Read with the Read tool at these exact paths:

**Electric SQL** (`node_modules/@electric-sql/playbook/skills/`):
- `electric/SKILL.md` — core Electric concepts and shape API
- `electric-tanstack-integration/SKILL.md` — how Electric + TanStack DB work together (READ FIRST)
- `electric-quickstart/SKILL.md` — quickstart patterns
- `electric-security-check/SKILL.md` — security best practices
- `tanstack-start-quickstart/SKILL.md` — TanStack Start framework patterns
- `deploying-electric/SKILL.md` — deployment configuration
- `electric-go-live/SKILL.md` — production checklist

**TanStack DB** (`node_modules/@tanstack/db-playbook/skills/`):
- `tanstack-db/SKILL.md` — overview: collections, useLiveQuery, mutations
- `tanstack-db/collections/SKILL.md` — collection setup, timestamp schema pattern (CRITICAL for data model)
- `tanstack-db/schemas/SKILL.md` — schema validation, TInput/TOutput
- `tanstack-db/mutations/SKILL.md` — insert, update, delete, optimistic updates
- `tanstack-db/live-queries/SKILL.md` — filtering, joins, aggregations
- `tanstack-db/electric/SKILL.md` — Electric-specific TanStack DB patterns

### Reading Order
1. `electric-tanstack-integration/SKILL.md` — integration overview
2. `tanstack-db/SKILL.md` — collections, queries, mutations API
3. `tanstack-db/collections/SKILL.md` — collection setup with correct timestamp pattern
4. `electric/SKILL.md` — shape API for proxy routes
5. Other sub-skills as needed for your current phase

### Important
- ONLY read playbooks relevant to your current phase
- Sub-skills (`tanstack-db/collections/`, `tanstack-db/schemas/`, etc.) have deeper detail — read them during implementation phases
- Note: playbook examples use `import { z } from "zod"` but this project requires `import { z } from "zod/v4"` because drizzle-zod 0.8.x peer-depends on zod >=3.25 which ships v4 as a subpath export, and `createSelectSchema` rejects v3 schema overrides

## Infrastructure (Pre-configured — DO NOT MODIFY)
The database (Postgres) and Electric sync service are already provisioned and configured via environment variables:
- `DATABASE_URL` — Postgres connection string
- `ELECTRIC_URL` — Electric sync service URL
- `ELECTRIC_SOURCE_ID` / `ELECTRIC_SECRET` — Electric Cloud auth (if using cloud mode)

These are read by:
- `src/db/index.ts` — Drizzle client (DO NOT MODIFY)
- `drizzle.config.ts` — Drizzle Kit migrations (DO NOT MODIFY)
- `src/lib/electric-proxy.ts` — Electric shape proxy for API routes (DO NOT MODIFY)

You do NOT need to set up database connections or configure Electric. Just define your schema, run migrations, and write your app.

## Operating Modes

### Prod Mode (NODE_ENV=production, STUDIO_DEV_MODE unset)
- Claude API key: pre-configured via ANTHROPIC_API_KEY env var on server
- GitHub: repos created in `electric-apps` org via GitHub App (credential helper in sandbox)
- Rate limiting: MAX_TOTAL_SESSIONS + MAX_SESSIONS_PER_IP_PER_HOUR + MAX_SESSION_COST_USD
- UI: no credential fields, no "Start from repo"
- POST /api/sessions/resume: returns 403
- POST /api/sessions/:id/github-token: returns installation token for sandbox git operations

### Dev Mode (STUDIO_DEV_MODE=1)
- User provides own Claude API key and GitHub token
- Full UI with all credential fields
- No rate limiting
- Can start from existing repos

### Environment Variables (Prod)
| Variable | Description | Default |
|----------|-------------|---------|
| MAX_TOTAL_SESSIONS | Max concurrent active sessions | 50 |
| MAX_SESSIONS_PER_IP_PER_HOUR | Per-IP session rate limit | 5 |
| MAX_SESSION_COST_USD | Per-session cost budget | 5 |

### Fly Secrets (Prod — GitHub App)
| Secret | Description |
|--------|-------------|
| GITHUB_APP_ID | GitHub App numeric ID |
| GITHUB_INSTALLATION_ID | Installation ID for electric-apps org |
| GITHUB_PRIVATE_KEY | PEM private key for JWT signing |

## Dev Server & Migrations
### Dev Server (CRITICAL — use pnpm scripts ONLY)
- `pnpm dev:start` — start the Vite dev server in the background
- `pnpm dev:stop` — stop the dev server
- `pnpm dev:restart` — stop then start

**IMPORTANT**: Always use `pnpm dev:start` from the project directory. Do NOT use `sprite-env services create` or launch Vite manually — the project's vite.config.ts contains required settings (allowedHosts, port, proxy) that will not be applied if Vite is started from a different directory or with different arguments.

The app listens on port 8080 (set via VITE_PORT) — this is the only port the Sprite proxy exposes.
The database and Electric sync service are remote (cloud-hosted) — there is no local Postgres or Docker.

### Migrations (CRITICAL)
After modifying src/db/schema.ts, ALWAYS run migrations:
```bash
pnpm drizzle-kit generate   # generate SQL from schema changes
pnpm drizzle-kit migrate    # apply migration to the database
```

### Workflow
After finishing ALL code generation: run migrations, then `pnpm dev:start` so the user can preview the app.

## SSR Configuration (CRITICAL)
NEVER add ssr: false to __root.tsx — it renders the HTML shell and must always SSR.
Instead, add ssr: false to each LEAF route that uses useLiveQuery or collections.
This is needed because useLiveQuery uses useSyncExternalStore without getServerSnapshot.

