/**
 * Generates CLAUDE.md files for project workspaces.
 */

export interface GitConfig {
	/** "create" — agent should git init + gh repo create after scaffolding */
	/** "existing" — repo was cloned; agent should commit + push after changes */
	mode: "create" | "existing"
	/** Full repo name, e.g. "owner/repo-name" */
	repoName: string
	/** Visibility for new repos (only relevant when mode=create) */
	visibility?: "public" | "private"
	/** Branch name (only relevant when mode=existing) */
	branch?: string
}

export interface ClaudeMdOptions {
	/** The user's app description */
	description: string
	/** Project name (kebab-case) */
	projectName: string
	/** Absolute path to the project inside the sandbox */
	projectDir: string
	/** Whether this is an iteration (vs initial generation) */
	isIteration?: boolean
	/** Iteration request text (if isIteration) */
	iterationRequest?: string
	/** Sandbox runtime — affects environment-specific instructions */
	runtime?: "docker" | "sprites" | "daytona"
	/** Git/GitHub configuration — when set, git instructions are injected */
	git?: GitConfig
}

export function generateClaudeMd(opts: ClaudeMdOptions): string {
	const sections: string[] = []

	sections.push(`# ${opts.projectName}`)
	sections.push("")
	sections.push(PROJECT_CONTEXT)
	sections.push("")

	const sandbox = sandboxEnvironment(opts.runtime)
	if (sandbox) {
		sections.push(sandbox)
		sections.push("")
	}

	if (!opts.isIteration) {
		sections.push("## Current Task")
		sections.push(opts.description)
		sections.push("")
		sections.push(SKILL_AUTO_TRIGGER)
		sections.push("")
	}

	sections.push(SCAFFOLD_STRUCTURE)
	sections.push("")
	sections.push(DRIZZLE_WORKFLOW)
	sections.push("")
	sections.push(GUARDRAILS)
	sections.push("")
	sections.push(PLAYBOOK_INSTRUCTIONS)
	sections.push("")
	sections.push(INFRASTRUCTURE)
	sections.push("")
	sections.push(devServerInstructions(opts.runtime))
	sections.push("")
	sections.push(SSR_RULES)
	sections.push("")

	const gitSection = gitInstructions(opts.git)
	if (gitSection) {
		sections.push(gitSection)
		sections.push("")
	}

	return sections.join("\n")
}

// ---------------------------------------------------------------------------
// Shared sections
// ---------------------------------------------------------------------------

const PROJECT_CONTEXT =
	"## Project Context\nThis is a reactive, real-time application built with Electric SQL + TanStack DB + Drizzle ORM + TanStack Start."

const SCAFFOLD_STRUCTURE = `## Scaffold Structure (DO NOT EXPLORE)
The project is scaffolded from a known template. DO NOT read or explore scaffold files before coding. You already know the structure:
- src/db/schema.ts — placeholder Drizzle schema (you will overwrite)
- src/db/zod-schemas.ts — placeholder Zod derivation (you will overwrite)
- src/db/index.ts — Drizzle client setup (do not modify)
- src/db/utils.ts — parseDates + generateTxId helpers (do not modify)
- src/lib/electric-proxy.ts — Electric shape proxy helper (do not modify)
- src/components/ClientOnly.tsx — SSR wrapper (do not modify, just import when needed)
- src/routes/__root.tsx — root layout with SSR (do not add ssr:false here)
- tests/helpers/schema-test-utils.ts — generateValidRow/generateRowWithout (do not modify)

DO NOT use Bash/ls/find to explore the project. DO NOT read files you aren't about to modify. Start writing code.`

const DRIZZLE_WORKFLOW = `## Drizzle Workflow (CRITICAL)
Always follow this order:
1. Edit src/db/schema.ts (Drizzle pgTable definitions)
2. Edit src/db/zod-schemas.ts (derive Zod schemas via createSelectSchema/createInsertSchema from drizzle-zod — NEVER hand-write Zod schemas — ALWAYS import z from "zod/v4" and override ALL timestamp columns with z.union([z.date(), z.string()]).default(() => new Date()) — the .default() is required so collection.insert() works without timestamps)
3. Create collection files in src/db/collections/ (import from ../zod-schemas)
4. Create API routes (proxy + mutation)
5. Create UI components`

const GUARDRAILS = `## Guardrails (MUST FOLLOW)

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
- ALL timestamp columns MUST use: z.union([z.date(), z.string()]).default(() => new Date())
- NEVER use z.coerce.date() — it breaks TanStack DB
- ALL tables MUST have REPLICA IDENTITY FULL (auto-applied by migration hook)
- UUID primary keys with defaultRandom()
- timestamp({ withTimezone: true }) for all dates
- snake_case for SQL table/column names
- Foreign keys with onDelete: "cascade" where appropriate`

function sandboxEnvironment(runtime?: string): string {
	if (runtime === "sprites" || runtime === "daytona") {
		return `## Sandbox Environment (IMPORTANT — READ FIRST)
You are running inside a cloud micro-VM (Fly.io Sprite). This is NOT a local machine.

### Networking & Port Exposure
- The Sprite HTTP proxy routes all external traffic to **port 8080** inside the VM
- Your app MUST listen on port 8080 to be accessible via the preview URL — this is pre-configured via the \`VITE_PORT\` environment variable
- The app MUST bind to \`0.0.0.0\` (not localhost) — pre-configured via \`host: true\` in vite.config.ts
- The preview URL follows the pattern: \`https://<sprite-name>.sprites.app\`
- There is NO way to expose other ports — only port 8080 is proxied

### What's Available
- Node.js (via nvm at \`/.sprite/languages/node/nvm/\`)
- pnpm, git, gh CLI
- Outbound internet access (npm install, API calls, etc.)
- \`DATABASE_URL\` — remote Postgres (Neon), no local database

### What's NOT Available
- Docker, docker-compose, or any container runtime
- Local Postgres or any local database
- Ports other than 8080 for external HTTP access

### PATH
- npm global binaries are NOT in PATH by default
- If you need a globally installed tool, source the profile first: \`source /etc/profile.d/npm-global.sh\``
	}
	return ""
}

function devServerInstructions(runtime?: string): string {
	if (runtime === "sprites" || runtime === "daytona") {
		return `## Dev Server & Migrations
### Dev Server (CRITICAL — use pnpm scripts ONLY)
- \`pnpm dev:start\` — start the Vite dev server in the background
- \`pnpm dev:stop\` — stop the dev server
- \`pnpm dev:restart\` — stop then start

**IMPORTANT**: Always use \`pnpm dev:start\` from the project directory. Do NOT use \`sprite-env services create\` or launch Vite manually — the project's vite.config.ts contains required settings (allowedHosts, port, proxy) that will not be applied if Vite is started from a different directory or with different arguments.

The app listens on port 8080 (set via VITE_PORT) — this is the only port the Sprite proxy exposes.
The database and Electric sync service are remote (cloud-hosted) — there is no local Postgres or Docker.

### Migrations (CRITICAL)
After modifying src/db/schema.ts, ALWAYS run migrations:
\`\`\`bash
pnpm drizzle-kit generate   # generate SQL from schema changes
pnpm drizzle-kit migrate    # apply migration to the database
\`\`\`

### Workflow
After finishing ALL code generation: run migrations, then \`pnpm dev:start\` so the user can preview the app.`
	}

	return `## Dev Server & Migrations
### Dev Server
- \`pnpm dev:start\` — start Vite + Postgres + Electric in the background
- \`pnpm dev:stop\` — stop all background services
- \`pnpm dev:restart\` — stop then start

The app is exposed on the VITE_PORT environment variable (default: 5173).

### Migrations (CRITICAL)
After modifying src/db/schema.ts, ALWAYS run migrations:
\`\`\`bash
pnpm dev:start              # start Postgres (needed for migrate)
pnpm drizzle-kit generate   # generate SQL from schema changes
pnpm drizzle-kit migrate    # apply migration to the database
\`\`\`

### Workflow
After finishing ALL code generation: run migrations, then \`pnpm dev:start\` so the user can preview the app.`
}

const SSR_RULES = `## SSR Configuration (CRITICAL)
NEVER add ssr: false to __root.tsx — it renders the HTML shell and must always SSR.
Instead, add ssr: false to each LEAF route that uses useLiveQuery or collections.
This is needed because useLiveQuery uses useSyncExternalStore without getServerSnapshot.`

const SKILL_AUTO_TRIGGER = `## App Generation Pipeline (CRITICAL)
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

Do NOT skip phases or code ad-hoc. Always follow the skill's structured pipeline.`

const PLAYBOOK_INSTRUCTIONS = `## Playbooks (Domain Knowledge — MUST READ)
Playbook SKILL.md files contain critical API usage patterns. Read them BEFORE writing code for each phase.

### Available Skills
Read with the Read tool at these exact paths:

**Electric SQL** (\`node_modules/@electric-sql/playbook/skills/\`):
- \`electric/SKILL.md\` — core Electric concepts and shape API
- \`electric-tanstack-integration/SKILL.md\` — how Electric + TanStack DB work together (READ FIRST)
- \`electric-quickstart/SKILL.md\` — quickstart patterns
- \`electric-security-check/SKILL.md\` — security best practices
- \`tanstack-start-quickstart/SKILL.md\` — TanStack Start framework patterns
- \`deploying-electric/SKILL.md\` — deployment configuration
- \`electric-go-live/SKILL.md\` — production checklist

**TanStack DB** (\`node_modules/@tanstack/db-playbook/skills/\`):
- \`tanstack-db/SKILL.md\` — collections, useLiveQuery, mutations (CRITICAL — read before writing any UI)

**Durable Streams** (\`node_modules/@durable-streams/playbook/skills/\`):
- \`durable-streams/SKILL.md\` — event streaming patterns
- \`durable-state/SKILL.md\` — state management
- \`durable-streams-dev-setup/SKILL.md\` — development setup

### Reading Order
1. \`electric-tanstack-integration/SKILL.md\` — integration rules and guardrails
2. \`tanstack-db/SKILL.md\` — collections, queries, mutations API
3. \`electric/SKILL.md\` — shape API for proxy routes
4. Other skills as needed for your current phase

### Important
- ONLY read playbooks relevant to your current phase
- Do NOT use include_references — the SKILL.md content is sufficient`

const INFRASTRUCTURE = `## Infrastructure (Pre-configured — DO NOT MODIFY)
The database (Postgres) and Electric sync service are already provisioned and configured via environment variables:
- \`DATABASE_URL\` — Postgres connection string
- \`ELECTRIC_URL\` — Electric sync service URL
- \`ELECTRIC_SOURCE_ID\` / \`ELECTRIC_SECRET\` — Electric Cloud auth (if using cloud mode)

These are read by:
- \`src/db/index.ts\` — Drizzle client (DO NOT MODIFY)
- \`drizzle.config.ts\` — Drizzle Kit migrations (DO NOT MODIFY)
- \`src/lib/electric-proxy.ts\` — Electric shape proxy for API routes (DO NOT MODIFY)

You do NOT need to set up database connections or configure Electric. Just define your schema, run migrations, and write your app.`

// ---------------------------------------------------------------------------
// Git instructions — generated based on the session's git config
// ---------------------------------------------------------------------------

function gitInstructions(git?: GitConfig): string {
	if (!git) return ""

	if (git.mode === "create") {
		const visibility = git.visibility === "public" ? "--public" : "--private"
		return `## Git & GitHub (CRITICAL)
You MUST run these git commands at two points during the session:

### 1. After scaffolding — initialize repo
Run this right after migrations, BEFORE \`pnpm dev:start\`:
\`\`\`bash
git init -b main
git add -A
git commit -m "chore: scaffold ${git.repoName.split("/").pop()}"
gh repo create "${git.repoName}" ${visibility} --source . --remote origin --push
\`\`\`

### 2. After app generation is complete — push final code
Run this as your FINAL action, after the dev server is running and all code is written:
\`\`\`bash
git add -A && git commit -m "feat: initial app implementation"
git push
\`\`\`

Commit types: feat, fix, refactor, style, chore, docs, test`
	}

	// mode === "existing"
	const branch = git.branch ?? "main"
	return `## Git & GitHub
This project was cloned from \`${git.repoName}\` (branch: \`${branch}\`). Git and remote are already configured.

After making changes, commit and push:
\`\`\`bash
git add -A && git commit -m "type(scope): description"
git push
\`\`\`
Commit types: feat, fix, refactor, style, chore, docs, test`
}

// ---------------------------------------------------------------------------
// Create-app skill content — exported so the server can write it to sandboxes
// where the npm-installed electric-agent may not include it yet.
// ---------------------------------------------------------------------------

export { createAppSkillContent } from "./create-app-skill.js"
export { roomMessagingSkillContent } from "./room-messaging-skill.js"
