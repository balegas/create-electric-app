import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk"

/**
 * Known-correct import map: package → valid exports.
 */
const CORRECT_IMPORTS: Record<string, string[]> = {
	"@tanstack/react-db": [
		"useLiveQuery",
		"createCollection",
		"eq",
		"and",
		"or",
		"gt",
		"lt",
		"count",
		"sum",
		"avg",
		"min",
		"max",
	],
	"@tanstack/db": [
		"eq",
		"gt",
		"lt",
		"and",
		"or",
		"not",
		"inArray",
		"count",
		"sum",
		"avg",
		"min",
		"max",
	],
	"@tanstack/electric-db-collection": [
		"electricCollectionOptions",
		"isChangeMessage",
		"isControlMessage",
	],
	"@electric-sql/client": ["ELECTRIC_PROTOCOL_QUERY_PARAMS", "ShapeStream", "Shape"],
	"@radix-ui/themes": [
		"Theme",
		"Container",
		"Flex",
		"Box",
		"Grid",
		"Section",
		"Heading",
		"Text",
		"Button",
		"IconButton",
		"TextField",
		"TextArea",
		"Select",
		"Checkbox",
		"Switch",
		"Slider",
		"Dialog",
		"DropdownMenu",
		"Badge",
		"Card",
		"Table",
		"Tabs",
		"Tooltip",
		"Avatar",
		"Separator",
		"ScrollArea",
	],
	"@tanstack/react-router": [
		"createFileRoute",
		"createRootRoute",
		"Link",
		"Outlet",
		"useNavigate",
		"useParams",
		"useSearch",
		"redirect",
	],
	"@tanstack/react-start": ["createStart"],
	"drizzle-orm": [
		"sql",
		"eq",
		"and",
		"or",
		"gt",
		"lt",
		"gte",
		"lte",
		"not",
		"inArray",
		"desc",
		"asc",
	],
	"drizzle-orm/pg-core": [
		"pgTable",
		"pgEnum",
		"uuid",
		"text",
		"varchar",
		"integer",
		"serial",
		"boolean",
		"timestamp",
		"jsonb",
		"numeric",
		"real",
		"date",
	],
	"drizzle-orm/zod": ["createSelectSchema", "createInsertSchema", "createUpdateSchema"],
	"drizzle-orm/postgres-js": ["drizzle"],
}

/**
 * Known hallucinated imports that should be corrected.
 */
const HALLUCINATION_MAP: Record<string, string> = {
	"drizzle-zod": "drizzle-orm/zod (drizzle-zod is deprecated since drizzle-orm 0.44.0)",
}

const IMPORT_REGEX = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g

/**
 * PreToolUse hook: Validate imports in file content against known-correct table.
 * Denies writes that contain hallucinated or incorrect imports.
 */
export const importValidation: HookCallback = async (input, _toolUseID, _opts) => {
	const preInput = input as PreToolUseHookInput
	const toolInput = preInput.tool_input as Record<string, unknown> | undefined

	// Get file content from either Write (content) or Edit (new_string)
	const content = toolInput?.content || toolInput?.new_string
	if (!content || typeof content !== "string") return {}

	// Only check TypeScript/JavaScript files
	const filePath = (toolInput?.file_path || "") as string
	if (!filePath.match(/\.(ts|tsx|js|jsx)$/)) return {}

	const issues: string[] = []

	for (const match of content.matchAll(IMPORT_REGEX)) {
		const imports = match[1]
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
		const pkg = match[2]

		// Check for known hallucinated packages
		if (HALLUCINATION_MAP[pkg]) {
			issues.push(`Hallucinated import: "${pkg}" → use ${HALLUCINATION_MAP[pkg]}`)
			continue
		}

		// Check against known-correct imports
		if (CORRECT_IMPORTS[pkg]) {
			for (const imp of imports) {
				const cleanImp = imp.replace(/\s+as\s+\w+/, "").trim()
				if (!CORRECT_IMPORTS[pkg].includes(cleanImp)) {
					issues.push(
						`Unknown export "${cleanImp}" from "${pkg}". Known exports: ${CORRECT_IMPORTS[pkg].join(", ")}`,
					)
				}
			}
		}
	}

	if (issues.length > 0) {
		return {
			hookSpecificOutput: {
				hookEventName: "PreToolUse" as const,
				permissionDecision: "deny" as const,
				permissionDecisionReason: `Import validation failed:\n${issues.join("\n")}`,
			},
		}
	}

	return {}
}
