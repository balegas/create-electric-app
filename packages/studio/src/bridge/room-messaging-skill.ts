/**
 * The room-messaging skill content as a string constant.
 *
 * Exported so the server can write the skill into sandboxes, ensuring agents
 * have persistent access to the multi-agent messaging protocol even after the
 * initial discovery prompt scrolls out of context.
 *
 * The content must stay in sync with .claude/skills/room-messaging/SKILL.md.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Read the room-messaging skill from the project root.
 * Falls back to an empty string if the file can't be found.
 */
function loadSkillContent(): string {
	const candidates = [
		// From studio/dist/bridge/ → project root .claude/skills/room-messaging/SKILL.md
		path.resolve(__dirname, "../../../../.claude/skills/room-messaging/SKILL.md"),
		// From studio/src/bridge/ → project root (dev mode)
		path.resolve(__dirname, "../../../.claude/skills/room-messaging/SKILL.md"),
		// Monorepo root from packages/studio/
		path.resolve(__dirname, "../../.claude/skills/room-messaging/SKILL.md"),
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

	console.warn("[room-messaging-skill] Could not find SKILL.md in any expected location")
	return ""
}

export const roomMessagingSkillContent = loadSkillContent()
