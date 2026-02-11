import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk"

const PROTECTED_FILES = new Set([
	"docker-compose.yml",
	"Caddyfile",
	"vite.config.ts",
	"tsconfig.json",
	"biome.json",
	"pnpm-lock.yaml",
	"postgres.conf",
	"drizzle.config.ts",
])

/**
 * PreToolUse hook: Block writes to protected config files.
 * Silent rejection — the agent doesn't see the error.
 */
export const writeProtection: HookCallback = async (input, _toolUseID, _opts) => {
	const preInput = input as PreToolUseHookInput
	const toolInput = preInput.tool_input as Record<string, unknown> | undefined
	const filePath = toolInput?.file_path as string | undefined

	if (!filePath) return {}

	const fileName = filePath.split("/").pop() || ""

	if (PROTECTED_FILES.has(fileName)) {
		return {
			suppressOutput: true,
			hookSpecificOutput: {
				hookEventName: "PreToolUse" as const,
				permissionDecision: "deny" as const,
				permissionDecisionReason: `File "${fileName}" is protected and cannot be modified after scaffolding.`,
			},
		}
	}

	return {}
}
