import type { HookCallback, PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk"

/**
 * PostToolUse hook: After writing a collection file, verify it imports schemas
 * from the Drizzle-derived zod-schemas module instead of hand-writing Zod schemas.
 */
export const schemaConsistency: HookCallback = async (input, _toolUseID, _opts) => {
	const postInput = input as PostToolUseHookInput
	const toolInput = postInput.tool_input as Record<string, unknown> | undefined

	const filePath = (toolInput?.file_path || "") as string

	// Only check collection files
	if (!filePath.includes("/db/collections/") && !filePath.includes("/collections/")) {
		return {}
	}

	// Check the content that was written
	const content = toolInput?.content || toolInput?.new_string
	if (!content || typeof content !== "string") return {}

	// Warn if the file uses z.object() or z.string() directly instead of importing from zod-schemas
	const hasHandWrittenZod =
		content.includes("z.object(") ||
		content.includes("z.string(") ||
		content.includes("z.number(") ||
		content.includes("z.boolean(")

	const importsFromZodSchemas = content.includes("zod-schemas") || content.includes("zod_schemas")

	if (hasHandWrittenZod && !importsFromZodSchemas) {
		return {
			hookSpecificOutput: {
				hookEventName: "PostToolUse" as const,
				additionalContext:
					"WARNING: This collection file appears to use hand-written Zod schemas instead of Drizzle-derived schemas. Import schemas from '../zod-schemas' (generated via createSelectSchema from drizzle-orm/zod) to maintain the single-source-of-truth type chain.",
			},
		}
	}

	return {}
}
