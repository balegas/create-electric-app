import type { HookCallback, PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk"

/**
 * PostToolUse hook: After writing a collection file, verify it imports schemas
 * from the Drizzle-derived zod-schemas module instead of hand-writing Zod schemas.
 *
 * Also checks zod-schemas files for:
 * - Missing timestamp overrides (Electric streams dates as ISO strings)
 * - Wrong zod import (must use "zod/v4", not "zod")
 * - Using z.coerce.date() (creates ZodEffects rejected by TanStack DB)
 */
export const schemaConsistency: HookCallback = async (input, _toolUseID, _opts) => {
	const postInput = input as PostToolUseHookInput
	const toolInput = postInput.tool_input as Record<string, unknown> | undefined

	const filePath = (toolInput?.file_path || "") as string
	const content = (toolInput?.content || toolInput?.new_string || "") as string
	if (!content) return {}

	// Check zod-schemas files for date override issues
	if (filePath.includes("zod-schemas")) {
		const warnings: string[] = []

		// Check for z.coerce.date() — creates ZodEffects that TanStack DB rejects
		if (content.includes("z.coerce.date()")) {
			warnings.push(
				"BLOCKED: z.coerce.date() creates ZodEffects/pipe types that TanStack DB's schema introspection rejects with 'Invalid element: expected a Zod schema'. Use z.union([z.date(), z.string()]) instead.",
			)
		}

		// Check for wrong zod import — must be "zod/v4" for drizzle-zod 0.8.x compatibility
		if (
			(content.includes('from "zod"') || content.includes("from 'zod'")) &&
			!content.includes("zod/v4")
		) {
			warnings.push(
				'BLOCKED: Import z from "zod/v4" instead of "zod". drizzle-zod 0.8.x uses Zod v4 internals, and the v4 runtime rejects v3-style schema overrides.',
			)
		}

		// Check for createSelectSchema without timestamp overrides
		if (
			content.includes("createSelectSchema") &&
			(content.includes("_at") || content.includes("At")) &&
			!content.includes("z.union") &&
			!content.includes("dateOrString")
		) {
			warnings.push(
				"WARNING: createSelectSchema appears to have timestamp columns without z.union([z.date(), z.string()]).default(() => new Date()) overrides. Electric SQL streams dates as ISO strings — without this override, collection.update() will throw SchemaValidationError.",
			)
		}

		// Check for z.union([z.date(), z.string()]) without .default() — causes collection.insert() to fail
		if (
			content.includes("z.union") &&
			(content.includes("_at") || content.includes("At")) &&
			!content.includes(".default(")
		) {
			warnings.push(
				"WARNING: Timestamp overrides use z.union([z.date(), z.string()]) without .default(() => new Date()). Without .default(), collection.insert() will throw SchemaValidationError on created_at/updated_at because the client doesn't provide them (the DB sets defaults server-side). Fix: const dateOrString = z.union([z.date(), z.string()]).default(() => new Date())",
			)
		}

		if (warnings.length > 0) {
			return {
				hookSpecificOutput: {
					hookEventName: "PostToolUse" as const,
					additionalContext: warnings.join("\n\n"),
				},
			}
		}

		return {}
	}

	// Only check collection files below this point
	if (!filePath.includes("/db/collections/") && !filePath.includes("/collections/")) {
		return {}
	}

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
					"WARNING: This collection file appears to use hand-written Zod schemas instead of Drizzle-derived schemas. Import schemas from '../zod-schemas' (generated via createSelectSchema from drizzle-zod) to maintain the single-source-of-truth type chain.",
			},
		}
	}

	return {}
}
