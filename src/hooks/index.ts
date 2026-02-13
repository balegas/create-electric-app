import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk"
import { blockBash } from "./block-bash.js"
import { dependencyGuard } from "./dependency-guard.js"
import { importValidation } from "./import-validation.js"
import { migrationValidation } from "./migration-validation.js"
import { schemaConsistency } from "./schema-consistency.js"
import { writeProtection } from "./write-protection.js"

/**
 * Guardrail hooks for the coder agent.
 */
export const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
	PreToolUse: [
		{ matcher: "Write|Edit", hooks: [writeProtection, importValidation, dependencyGuard] },
		{ matcher: "Bash", hooks: [migrationValidation] },
	],
	PostToolUse: [{ matcher: "Write|Edit", hooks: [schemaConsistency] }],
}

/**
 * Hooks for the planner agent — blocks Bash and Write to keep it focused on reading playbooks.
 */
export const plannerHooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
	PreToolUse: [
		{ matcher: "Bash", hooks: [blockBash] },
		{ matcher: "Write|Edit", hooks: [blockBash] },
	],
}
