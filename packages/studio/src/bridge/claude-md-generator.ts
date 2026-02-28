/**
 * Generates a CLAUDE.md file for a project workspace so that Claude Code
 * automatically picks up Electric SQL + TanStack DB conventions, guardrails,
 * and workflow instructions.
 *
 * This replaces the system prompt that was previously passed to the Agent
 * SDK's query() function, and the hook-based guardrails.
 */

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
}

export function generateClaudeMd(opts: ClaudeMdOptions): string {
	const sections: string[] = []

	sections.push(`# ${opts.projectName}`)
	sections.push("")
	sections.push("## Project Context")
	sections.push(
		"This is a reactive, real-time application built with Electric SQL + TanStack DB + Drizzle ORM + TanStack Start.",
	)
	sections.push("")

	if (!opts.isIteration) {
		sections.push("## Current Task")
		sections.push(opts.description)
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
	sections.push(BUILD_INSTRUCTIONS)
	sections.push("")
	sections.push(ARCHITECTURE_REFERENCE)
	sections.push("")
	sections.push(GIT_INSTRUCTIONS)
	sections.push("")
	sections.push(SSR_RULES)
	sections.push("")
	sections.push(ERROR_HANDLING)
	sections.push("")

	return sections.join("\n")
}

// ---------------------------------------------------------------------------
// Template sections
// ---------------------------------------------------------------------------

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

const PLAYBOOK_INSTRUCTIONS = `## Playbooks (Domain Knowledge)
Playbook skill files are available in node_modules. Read them before implementing each phase:

### How to Read Playbooks
Use the Read tool to read playbook SKILL.md files:
- \`node_modules/@electric-sql/playbook/skills/<name>/SKILL.md\`
- \`node_modules/@tanstack/db-playbook/skills/<name>/SKILL.md\`
- \`node_modules/@durable-streams/playbook/skills/<name>/SKILL.md\`

### Required Reading Order
1. Read the electric-app-guardrails playbook FIRST (critical integration rules)
2. Read "schemas" before writing Drizzle schemas
3. Read "collections" before creating collection files
4. Read "mutations" before creating mutation routes
5. Read "live-queries" before creating UI with useLiveQuery

### Important
- ONLY read playbooks relevant to your current phase
- Do NOT use include_references — the SKILL.md content is sufficient`

const BUILD_INSTRUCTIONS = `## Build & Test
Run these commands to verify your work:
- \`pnpm run build\` — TypeScript compilation
- \`pnpm run check\` — Biome lint + format check
- \`pnpm test\` — Run tests (if tests/ directory exists)

Build only twice during initial generation: once after finishing all code, once after tests.
During iterations, build after completing changes.`

const ARCHITECTURE_REFERENCE = `## Architecture Reference

### Writing ARCHITECTURE.md (Initial Generation)
After ALL tasks are complete and the build passes, write ARCHITECTURE.md in the project root as your FINAL action. This is a concise navigation index — not documentation. Keep it under 1500 tokens.

Format:
\`\`\`
# [App Name] — Architecture Reference
_Last updated: [ISO date]_

## App Description
[1-2 sentences]

## Data Model
### [EntityName] (\`table_name\`)
- **Columns**: id (uuid PK), title (text), created_at (timestamptz)
- **Relations**: [none | field → table.id cascade]
- **Collection**: src/db/collections/[entity].ts

## API Routes
| Method | Path | File | Purpose |

## UI Routes & Components
| Route | File | Description |

### Key Components
- src/components/X.tsx — [one line: what it renders]

## Styling
- CSS files: [file: purpose]
\`\`\`

### Using ARCHITECTURE.md (Iteration Mode)
On iterations, read ARCHITECTURE.md to understand the app structure. Use it to locate files — do NOT scan the filesystem.`

const GIT_INSTRUCTIONS = `## Git & GitHub CLI
You have git and gh CLI available via Bash. Use them when needed:
- \`git status\` / \`git diff --stat\` — check current state
- \`git add -A && git commit -m "type(scope): description"\` — commit changes
- \`git push -u origin main\` — push to remote
- \`gh repo create "org/name" --private --source . --remote origin --push\` — create repo
- \`gh pr create --title "..." --body "..."\` — create PR
Commit types: feat, fix, refactor, style, chore, docs, test`

const SSR_RULES = `## SSR Configuration (CRITICAL)
NEVER add ssr: false to __root.tsx — it renders the HTML shell and must always SSR.
Instead, add ssr: false to each LEAF route that uses useLiveQuery or collections.
This is needed because useLiveQuery uses useSyncExternalStore without getServerSnapshot.`

const ERROR_HANDLING = `## Error Handling
Before fixing any error, check _agent/errors.md for previous attempts at the same fix.
If you see the same error has failed before, try a different approach.
After fixing an error, log the outcome.`
