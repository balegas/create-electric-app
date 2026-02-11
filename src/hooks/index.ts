import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk"
import { dependencyGuard } from "./dependency-guard.js"
import { importValidation } from "./import-validation.js"
import { migrationValidation } from "./migration-validation.js"
import { schemaConsistency } from "./schema-consistency.js"
import { writeProtection } from "./write-protection.js"

/**
 * All guardrail hooks composed for the Agent SDK.
 */
export const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
	PreToolUse: [
		{ matcher: "Write|Edit", hooks: [writeProtection, importValidation, dependencyGuard] },
		{ matcher: "Bash", hooks: [migrationValidation] },
	],
	PostToolUse: [{ matcher: "Write|Edit", hooks: [schemaConsistency] }],
}
