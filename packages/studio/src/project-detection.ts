import fs from "node:fs"
import path from "node:path"
import type { InfraConfig, SandboxHandle, SandboxProvider } from "./sandbox/types.js"

export interface ProjectDetection {
	isElectricAgentProject: boolean
	hasArchitectureMd: boolean
	hasEnvCredentials: boolean
	hasCompleteScaffold: boolean
	projectName: string | null
}

/**
 * Detect whether a project inside a sandbox is an electric-agent-generated
 * Electric SQL + TanStack DB application by checking multiple filesystem
 * markers in a single shell call.
 */
export async function detectProject(
	sandbox: SandboxProvider,
	handle: SandboxHandle,
	projectDir: string,
): Promise<ProjectDetection> {
	const script = `cd '${projectDir}' 2>/dev/null || exit 1

# Check package.json dependencies
HAS_TANSTACK_DB=false
HAS_ELECTRIC=false
HAS_DRIZZLE=false
PROJECT_NAME=""
if [ -f package.json ]; then
  grep -q '"@tanstack/db"' package.json 2>/dev/null && HAS_TANSTACK_DB=true
  grep -q '"@electric-sql/client"' package.json 2>/dev/null && HAS_ELECTRIC=true
  grep -q '"drizzle-orm"' package.json 2>/dev/null && HAS_DRIZZLE=true
  PROJECT_NAME=$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' package.json 2>/dev/null | head -1 | sed 's/.*"name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/')
fi

# Check file existence
HAS_DRIZZLE_CONFIG=$(test -f drizzle.config.ts && echo true || echo false)
HAS_SCHEMA=$(test -f src/db/schema.ts && echo true || echo false)
HAS_ARCHITECTURE=$(test -f ARCHITECTURE.md && echo true || echo false)

# Check .env credentials (non-empty, non-placeholder values)
HAS_ENV_CREDS=false
if [ -f .env ]; then
  DB_URL=$(grep '^DATABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2-)
  E_URL=$(grep '^ELECTRIC_URL=' .env 2>/dev/null | head -1 | cut -d= -f2-)
  if [ -n "$DB_URL" ] && [ "$DB_URL" != "postgresql://user:pass@host:5432/dbname" ] && [ -n "$E_URL" ] && [ "$E_URL" != "https://api.electric-sql.cloud" ]; then
    HAS_ENV_CREDS=true
  fi
fi

# All three deps = electric-agent project
IS_EA=false
if [ "$HAS_TANSTACK_DB" = "true" ] && [ "$HAS_ELECTRIC" = "true" ] && [ "$HAS_DRIZZLE" = "true" ]; then
  IS_EA=true
fi

HAS_SCAFFOLD=false
if [ "$HAS_DRIZZLE_CONFIG" = "true" ] && [ "$HAS_SCHEMA" = "true" ]; then
  HAS_SCAFFOLD=true
fi

echo "{\\"isElectricAgentProject\\": $IS_EA, \\"hasArchitectureMd\\": $HAS_ARCHITECTURE, \\"hasEnvCredentials\\": $HAS_ENV_CREDS, \\"hasCompleteScaffold\\": $HAS_SCAFFOLD, \\"projectName\\": \\"$PROJECT_NAME\\"}"
`

	try {
		const output = await sandbox.exec(handle, script)
		const jsonLine = output.trim().split("\n").pop() ?? "{}"
		return JSON.parse(jsonLine) as ProjectDetection
	} catch {
		return {
			isElectricAgentProject: false,
			hasArchitectureMd: false,
			hasEnvCredentials: false,
			hasCompleteScaffold: false,
			projectName: null,
		}
	}
}

/**
 * Ensure the iterate-app skill exists in the sandbox project.
 * Reads the SKILL.md from the agent template directory (at server runtime)
 * and writes it into the sandbox if missing.
 */
export async function ensureIterateSkill(
	sandbox: SandboxProvider,
	handle: SandboxHandle,
	projectDir: string,
): Promise<void> {
	// Try to read from the agent template directory (relative to this file's location)
	// packages/studio/src/project-detection.ts → packages/agent/template/.claude/skills/iterate-app/SKILL.md
	const studioSrc = path.dirname(new URL(import.meta.url).pathname)
	const templateSkill = path.resolve(
		studioSrc,
		"../../agent/template/.claude/skills/iterate-app/SKILL.md",
	)

	let skillContent: string
	try {
		skillContent = fs.readFileSync(templateSkill, "utf-8")
	} catch {
		// Fallback: minimal skill reference
		skillContent = [
			"---",
			"name: iterate-app",
			"description: Iterate on an existing Electric SQL + TanStack DB application.",
			"argument-hint: <iteration request>",
			"allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Agent, WebSearch, TodoWrite",
			"---",
			"",
			"# Iterate on Electric SQL App",
			"",
			"Read ARCHITECTURE.md to understand the project, plan changes, execute following the Drizzle Workflow, build & test, then update ARCHITECTURE.md.",
		].join("\n")
	}

	// Escape single quotes for the heredoc
	const escaped = skillContent.replace(/'/g, "'\\''")
	await sandbox.exec(
		handle,
		`mkdir -p '${projectDir}/.claude/skills/iterate-app' && cat > '${projectDir}/.claude/skills/iterate-app/SKILL.md' << 'ITERATESKILL_EOF'\n${escaped}\nITERATESKILL_EOF`,
	)
}

/**
 * Write infrastructure credentials to the project's .env file inside the sandbox.
 */
export async function writeCredentialsToSandbox(
	sandbox: SandboxProvider,
	handle: SandboxHandle,
	projectDir: string,
	infra: InfraConfig,
): Promise<void> {
	if (infra.mode === "local") return

	const lines = [
		`DATABASE_URL=${infra.databaseUrl}`,
		`ELECTRIC_URL=${infra.electricUrl}`,
		`ELECTRIC_SOURCE_ID=${infra.sourceId}`,
		`ELECTRIC_SECRET=${infra.secret}`,
	]

	// Append to .env (or create it), preserving any existing non-credential lines
	const script = `cd '${projectDir}' && {
  # Remove old credential lines if present
  if [ -f .env ]; then
    grep -v '^DATABASE_URL=' .env | grep -v '^ELECTRIC_URL=' | grep -v '^ELECTRIC_SOURCE_ID=' | grep -v '^ELECTRIC_SECRET=' > .env.tmp || true
    mv .env.tmp .env
  fi
  # Append new credentials
  cat >> .env << 'CREDS_EOF'
${lines.join("\n")}
CREDS_EOF
}`
	await sandbox.exec(handle, script)
}
