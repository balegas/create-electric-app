import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Resolve the bundled guardrails SKILL.md that ships with electric-agent.
 * Returns the file content stripped of YAML frontmatter.
 */
function loadGuardrails(): string | null {
	const dirs = [
		path.resolve(__dirname, "../../playbooks/electric-app-guardrails/SKILL.md"),
		path.resolve(__dirname, "../playbooks/electric-app-guardrails/SKILL.md"),
	]

	for (const filePath of dirs) {
		if (fs.existsSync(filePath)) {
			const raw = fs.readFileSync(filePath, "utf-8")
			// Strip YAML frontmatter
			return raw.replace(/^---\n[\s\S]*?\n---\n*/, "")
		}
	}

	return null
}

/**
 * SessionStart hook: Auto-inject the electric-app-guardrails playbook content
 * as additional context at the start of every coder session.
 *
 * This ensures the agent always has critical guardrail rules in context,
 * regardless of whether the PLAN.md tells it to read the playbook or
 * whether it skips Phase 0.
 */
export const guardrailInject: HookCallback = async () => {
	const content = loadGuardrails()
	if (!content) return {}

	return {
		hookSpecificOutput: {
			hookEventName: "SessionStart" as const,
			additionalContext: `<electric-app-guardrails>\n${content}\n</electric-app-guardrails>`,
		},
	}
}

/**
 * Create a SessionStart hook that injects both guardrails AND ARCHITECTURE.md.
 * ARCHITECTURE.md provides the coder with immediate structural knowledge of the app,
 * saving 3-5 turns of file scanning on iterations.
 */
export function createSessionStartHook(projectDir: string): HookCallback {
	return async () => {
		const parts: string[] = []

		const guardrails = loadGuardrails()
		if (guardrails) {
			parts.push(`<electric-app-guardrails>\n${guardrails}\n</electric-app-guardrails>`)
		}

		const archPath = path.join(projectDir, "ARCHITECTURE.md")
		if (fs.existsSync(archPath)) {
			const arch = fs.readFileSync(archPath, "utf-8")
			parts.push(`<app-architecture>\n${arch}\n</app-architecture>`)
		}

		if (parts.length === 0) return {}
		return {
			hookSpecificOutput: {
				hookEventName: "SessionStart" as const,
				additionalContext: parts.join("\n\n"),
			},
		}
	}
}
