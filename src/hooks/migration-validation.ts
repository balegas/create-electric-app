import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk"
import fs from "node:fs"
import path from "node:path"

const CREATE_TABLE_REGEX = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/gi
const REPLICA_IDENTITY_REGEX = /ALTER\s+TABLE\s+["']?(\w+)["']?\s+REPLICA\s+IDENTITY\s+FULL/gi

/**
 * PreToolUse hook: Intercept `drizzle-kit migrate` or `drizzle-kit push` commands.
 * Before allowing the command, scan all .sql files in drizzle/ and ensure every
 * CREATE TABLE has a corresponding ALTER TABLE ... REPLICA IDENTITY FULL.
 * Auto-fixes by appending the missing ALTER statements.
 */
export const migrationValidation: HookCallback = async (input, _toolUseID, _opts) => {
	const preInput = input as PreToolUseHookInput
	const command = (preInput.tool_input as any)?.command as string | undefined

	if (!command) return {}

	// Only intercept drizzle-kit migrate or push
	if (!command.includes("drizzle-kit migrate") && !command.includes("drizzle-kit push")) {
		return {}
	}

	const cwd = input.cwd || process.cwd()
	const drizzleDir = path.join(cwd, "drizzle")

	if (!fs.existsSync(drizzleDir)) return {}

	let fixed = false

	for (const file of fs.readdirSync(drizzleDir)) {
		if (!file.endsWith(".sql")) continue

		const filePath = path.join(drizzleDir, file)
		let content = fs.readFileSync(filePath, "utf-8")

		// Find all CREATE TABLE statements
		const createTables = new Set<string>()
		for (const match of content.matchAll(CREATE_TABLE_REGEX)) {
			createTables.add(match[1].toLowerCase())
		}

		// Find all REPLICA IDENTITY FULL statements
		const replicaTables = new Set<string>()
		for (const match of content.matchAll(REPLICA_IDENTITY_REGEX)) {
			replicaTables.add(match[1].toLowerCase())
		}

		// Append missing REPLICA IDENTITY FULL
		const missing = [...createTables].filter((t) => !replicaTables.has(t))
		if (missing.length > 0) {
			const additions = missing
				.map((table) => `\nALTER TABLE "${table}" REPLICA IDENTITY FULL;`)
				.join("\n")

			fs.appendFileSync(filePath, additions + "\n", "utf-8")
			fixed = true
		}
	}

	if (fixed) {
		return {
			hookSpecificOutput: {
				hookEventName: "PreToolUse" as const,
				permissionDecision: "allow" as const,
				permissionDecisionReason:
					"Auto-appended REPLICA IDENTITY FULL to migration files for Electric compatibility.",
			},
		}
	}

	return {}
}
