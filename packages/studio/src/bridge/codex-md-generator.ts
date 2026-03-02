/**
 * Generates AGENTS.md files for Codex CLI project workspaces.
 *
 * Reuses the same stack-specific content constants from claude-md-generator.ts
 * since the instructions are framework-specific (Electric SQL + TanStack DB),
 * not agent-specific.
 */

import type { ClaudeMdOptions } from "./claude-md-generator.js"
import {
	DRIZZLE_WORKFLOW,
	devServerInstructions,
	GUARDRAILS,
	INFRASTRUCTURE,
	PLAYBOOK_INSTRUCTIONS,
	PROJECT_CONTEXT,
	SCAFFOLD_STRUCTURE,
	SSR_RULES,
	sandboxEnvironment,
} from "./claude-md-generator.js"

/**
 * Generate an AGENTS.md file for Codex CLI mode.
 * Uses the same stack-specific content as Claude Code mode.
 */
export function generateCodexMd(opts: ClaudeMdOptions): string {
	const sections: string[] = []

	sections.push(`# ${opts.projectName}`)
	sections.push("")
	sections.push(PROJECT_CONTEXT)
	sections.push("")

	const sandbox = sandboxEnvironment(opts.runtime)
	if (sandbox) {
		sections.push(sandbox)
		sections.push("")
	}

	if (!opts.isIteration) {
		sections.push("## Current Task")
		sections.push(opts.description)
		sections.push("")
	}

	sections.push(SCAFFOLD_STRUCTURE)
	sections.push("")
	sections.push(DRIZZLE_WORKFLOW)
	sections.push("")
	sections.push(GUARDRAILS)
	sections.push("")
	sections.push(PLAYBOOK_INSTRUCTIONS)
	sections.push("")
	sections.push(INFRASTRUCTURE)
	sections.push("")
	sections.push(devServerInstructions(opts.runtime))
	sections.push("")
	sections.push(SSR_RULES)
	sections.push("")

	return sections.join("\n")
}
