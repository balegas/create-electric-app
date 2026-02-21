import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk"
import { blockBash } from "./block-bash.js"
import { dependencyGuard } from "./dependency-guard.js"
import { createSessionStartHook, guardrailInject } from "./guardrail-inject.js"
import { importValidation } from "./import-validation.js"
import { migrationValidation } from "./migration-validation.js"
import { schemaConsistency } from "./schema-consistency.js"
import { writeProtection } from "./write-protection.js"

/**
 * Create guardrail hooks for the coder agent, including projectDir-aware hooks.
 * The SessionStart hook injects both guardrails and ARCHITECTURE.md (when it exists).
 */
export function createCoderHooks(
	projectDir: string,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	return {
		SessionStart: [{ hooks: [createSessionStartHook(projectDir)] }],
		PreToolUse: [
			{ matcher: "Write|Edit", hooks: [writeProtection, importValidation, dependencyGuard] },
			{ matcher: "Bash", hooks: [migrationValidation] },
		],
		PostToolUse: [{ matcher: "Write|Edit", hooks: [schemaConsistency] }],
	}
}

/**
 * Static hooks (guardrails only, no ARCHITECTURE.md injection).
 */
export const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
	SessionStart: [{ hooks: [guardrailInject] }],
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
