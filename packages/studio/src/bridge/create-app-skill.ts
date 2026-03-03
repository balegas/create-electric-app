/**
 * The create-app skill content as a string constant.
 *
 * This is exported so the server can write the skill to sandboxes where the
 * npm-installed electric-agent package may not include it yet (e.g. version
 * mismatch between the server and the globally installed CLI).
 *
 * The content must stay in sync with packages/agent/template/.claude/skills/create-app/SKILL.md.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Read the create-app skill from the agent template directory.
 * Falls back to a minimal stub if the file can't be found (e.g. in tests).
 */
function loadSkillContent(): string {
	// Path from studio/dist/bridge/ → agent/template/.claude/skills/create-app/SKILL.md
	const candidates = [
		path.resolve(__dirname, "../../../agent/template/.claude/skills/create-app/SKILL.md"),
		// In npm-installed context, the agent package may be in node_modules
		path.resolve(
			__dirname,
			"../../node_modules/@electric-agent/agent/template/.claude/skills/create-app/SKILL.md",
		),
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

	console.warn("[create-app-skill] Could not find SKILL.md in any expected location")
	return ""
}

export const createAppSkillContent = loadSkillContent()
