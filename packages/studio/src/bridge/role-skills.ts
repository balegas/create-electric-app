/**
 * Role-based skill loader.
 *
 * Maps agent roles to skill files and tool permission sets.
 * Built-in roles (coder, reviewer) get specific behavioral guidelines
 * and restricted tool permissions to enforce isolation between roles.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Role aliases → canonical role name
// ---------------------------------------------------------------------------

const ROLE_ALIASES: Record<string, string> = {
	coder: "coder",
	developer: "coder",
	programmer: "coder",
	engineer: "coder",
	reviewer: "reviewer",
	"code reviewer": "reviewer",
	"pr reviewer": "reviewer",
}

// ---------------------------------------------------------------------------
// Tool permissions per role
// ---------------------------------------------------------------------------

/** Full tool set — same as DEFAULT_ALLOWED_TOOLS in the bridges. */
const ALL_TOOLS = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Glob",
	"Grep",
	"WebSearch",
	"TodoWrite",
	"AskUserQuestion",
	"Skill",
]

/**
 * Coder gets full write access — can read, write, edit, run commands.
 */
const CODER_TOOLS = [...ALL_TOOLS]

/**
 * Reviewer is read-only + Bash (for gh CLI).
 * Cannot Write or Edit files — only review and comment.
 */
const REVIEWER_TOOLS = [
	"Read",
	"Bash",
	"Glob",
	"Grep",
	"WebSearch",
	"TodoWrite",
	"AskUserQuestion",
	"Skill",
]

const ROLE_TOOLS: Record<string, string[]> = {
	coder: CODER_TOOLS,
	reviewer: REVIEWER_TOOLS,
}

// ---------------------------------------------------------------------------
// Skill file loading
// ---------------------------------------------------------------------------

const roleSkillCache = new Map<string, string>()

function loadSkillFile(roleName: string): string | undefined {
	const candidates = [
		// From studio/dist/bridge/ → project root
		path.resolve(__dirname, `../../../../.claude/skills/roles/${roleName}/SKILL.md`),
		// From studio/src/bridge/ → project root (dev mode)
		path.resolve(__dirname, `../../../.claude/skills/roles/${roleName}/SKILL.md`),
		// Monorepo root from packages/studio/
		path.resolve(__dirname, `../../.claude/skills/roles/${roleName}/SKILL.md`),
	]

	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) {
				return fs.readFileSync(candidate, "utf-8")
			}
		} catch {
			// Continue to next candidate
		}
	}

	return undefined
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RoleSkill {
	/** Canonical role name (e.g. "coder", "reviewer"). */
	roleName: string
	/** Markdown content of the role skill file. */
	skillContent: string
	/** Allowed tools for this role. When undefined, use default tools. */
	allowedTools?: string[]
}

/**
 * Resolve a role string to its skill content and tool permissions.
 * Returns undefined if the role doesn't match a built-in role.
 */
export function resolveRoleSkill(role?: string): RoleSkill | undefined {
	if (!role) return undefined
	const normalized = role.toLowerCase().trim()
	const roleName = ROLE_ALIASES[normalized]
	if (!roleName) return undefined

	// Load skill content (with cache)
	if (!roleSkillCache.has(roleName)) {
		const content = loadSkillFile(roleName)
		if (!content) {
			console.warn(`[role-skills] Skill file not found for role "${roleName}"`)
			return undefined
		}
		roleSkillCache.set(roleName, content)
	}

	const skillContent = roleSkillCache.get(roleName)!
	return {
		roleName,
		skillContent,
		allowedTools: ROLE_TOOLS[roleName],
	}
}

/**
 * Get the list of all known built-in role names.
 */
export function getBuiltInRoles(): string[] {
	return [...new Set(Object.values(ROLE_ALIASES))]
}
