import type { HookCallback } from "@anthropic-ai/claude-agent-sdk"

/**
 * PreToolUse hook: Block all Bash tool usage.
 * Used by the planner agent which should only read playbooks, not explore the filesystem.
 */
export const blockBash: HookCallback = async () => {
	return {
		suppressOutput: true,
		hookSpecificOutput: {
			hookEventName: "PreToolUse" as const,
			permissionDecision: "deny" as const,
			permissionDecisionReason:
				"Bash is not allowed. Use read_playbook and list_playbooks tools instead. Produce the plan from playbook knowledge.",
		},
	}
}
