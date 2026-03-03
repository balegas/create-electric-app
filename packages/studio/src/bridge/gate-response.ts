/**
 * Shared gate response formatter used by Docker and Sprites bridges.
 * Converts gate type + value into a user message string for Claude Code's stdin.
 */

/**
 * Format a gate response into a user message string for Claude Code.
 * Returns `null` if the gate type is not recognized.
 */
export function formatGateMessage(gate: string, value: Record<string, unknown>): string | null {
	if (gate === "ask_user_question" || gate.startsWith("ask_user_question:")) {
		// New format: answers is Record<string, string> (multiple questions)
		const answers = value.answers as Record<string, string> | undefined
		if (answers && typeof answers === "object" && !Array.isArray(answers)) {
			const entries = Object.entries(answers)
			if (entries.length === 1) {
				return entries[0][1]
			}
			return entries.map(([q, a]) => `${q}: ${a}`).join("\n")
		}
		// Legacy format: single answer string
		return (value.answer as string) || ""
	}

	if (gate === "clarification") {
		const answers = value.answers as string[] | undefined
		if (answers?.length) {
			return answers.join("\n")
		}
		return null
	}

	if (gate === "approval") {
		return (value.decision as string) || "approve"
	}

	if (gate === "continue") {
		const proceed = value.proceed as boolean
		return proceed ? "continue" : "stop"
	}

	// Unknown gate — send as JSON
	return JSON.stringify(value)
}
