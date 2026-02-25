import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk"

/**
 * PreToolUse hook: Prevent removal of existing dependencies from package.json.
 * Allows additions, blocks removals.
 */
export const dependencyGuard: HookCallback = async (input, _toolUseID, _opts) => {
	const preInput = input as PreToolUseHookInput
	const toolInput = preInput.tool_input as Record<string, unknown> | undefined

	const filePath = (toolInput?.file_path || "") as string
	if (!filePath.endsWith("package.json")) return {}

	// For Write tool, compare new content against what exists
	const newContent = toolInput?.content as string | undefined
	if (!newContent) return {}

	// For Edit tool, we get old_string and new_string
	const oldString = toolInput?.old_string as string | undefined
	if (oldString) {
		// Check if the edit removes dependency lines
		const oldDeps = extractDependencyNames(oldString)
		const newString = (toolInput?.new_string || "") as string
		const newDeps = extractDependencyNames(newString)

		const removed = oldDeps.filter((d) => !newDeps.includes(d))
		if (removed.length > 0) {
			return {
				hookSpecificOutput: {
					hookEventName: "PreToolUse" as const,
					permissionDecision: "deny" as const,
					permissionDecisionReason: `Cannot remove existing dependencies: ${removed.join(", ")}. Only additions are allowed.`,
				},
			}
		}
	}

	return {}
}

function extractDependencyNames(content: string): string[] {
	const deps: string[] = []
	const depRegex = /"([^"]+)":\s*"/g
	for (const match of content.matchAll(depRegex)) {
		deps.push(match[1])
	}
	return deps
}
