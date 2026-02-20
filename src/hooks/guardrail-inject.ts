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
